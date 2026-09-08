import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

export * from "@prisma/client";
export { PrismaClient };

// A single client per process. Next.js dev reloads the module graph on every
// edit, which would otherwise open a new pool each time until Postgres runs
// out of connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Issuer Better Auth stamps on email/password accounts. Anything that writes a
 * credential row — the seed, the admin account form — has to use it, because
 * sign-in looks the account up by (issuer, accountId).
 */
export const CREDENTIAL_ISSUER = "local:credential";
export const CREDENTIAL_PROVIDER_ID = "credential";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Device and enrollment tokens are 32 random bytes, so a plain sha256 is
/// enough to store them — there is nothing to brute-force. Passwords use
/// bcrypt instead.
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Admin sync
// ---------------------------------------------------------------------------

/**
 * Upserts the admin account from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
 *
 * Called on every hub boot, so the login always tracks the env vars — change
 * `ADMIN_PASSWORD` and restart the hub, no seed step needed. Also called from
 * the optional seed script, so `pnpm db:seed` stays in sync with the same
 * logic rather than duplicating it.
 */
export async function syncAdminFromEnv(): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.ADMIN_PASSWORD ?? "change-me-please";

  // Better Auth keeps credentials on the account row, not the user. The auth
  // config points its hasher at bcrypt precisely so this can create/update the
  // admin without importing Better Auth here.
  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: "ADMIN" },
    create: {
      email,
      name: "Admin",
      emailVerified: true,
      role: "ADMIN",
    },
  });

  const passwordHash = await bcrypt.hash(password, 12);
  const credential = await prisma.account.findFirst({
    where: { userId: admin.id, providerId: CREDENTIAL_PROVIDER_ID },
  });

  if (credential) {
    await prisma.account.update({
      where: { id: credential.id },
      data: { password: passwordHash, issuer: CREDENTIAL_ISSUER },
    });
  } else {
    await prisma.account.create({
      data: {
        userId: admin.id,
        issuer: CREDENTIAL_ISSUER,
        providerId: CREDENTIAL_PROVIDER_ID,
        accountId: admin.id,
        password: passwordHash,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Hub settings
// ---------------------------------------------------------------------------

/**
 * Fleet-wide operational knobs, editable from Settings instead of env — see
 * the `Setting` model's own doc comment. Read on every scheduler tick / poll
 * check, so a change here takes effect without restarting the hub.
 */
export type HubSettingsValues = {
  // Three knobs used to live here and no longer do: how often an index is read
  // is a column on `SourceFeed`, and the wait between automatic rollouts is a
  // column on `AppTarget`. Both were only ever fleet-wide because there was
  // nowhere else to put them — a mirror that publishes hourly and one that
  // publishes on release want different cadences, and so do a scanner people
  // watch all day and a launcher nobody notices. The third, how often Rotom is
  // asked about the fleet, went to the monitoring group — it is read by the
  // monitor and its stale delay is measured against it, so the two belong in
  // one form. Their old rows are inert: `readGroup` only reads the keys with
  // defaults here.

  /** Fleet-wide cap on devices downloading/installing at the same time. */
  maxConcurrentJobs: number;
  /** Seconds without a job_progress message before a job is considered stalled. */
  jobStallTimeoutSeconds: number;
  /**
   * Seconds between stored readings. Boxes beat every 20 seconds and no chart
   * is read at that resolution, so the hub keeps one beat per interval and
   * drops the rest. Floored at the heartbeat interval — asking for less than 20
   * just stores every beat.
   *
   * Two kinds of history ride this, from two different sources: the box's own
   * readings off the heartbeat, and what Rotom says about it off the Rotom
   * sync, which runs far more often. One grid for both, so a chart on either
   * page means the same thing by a point.
   *
   * The heartbeat floor is the awkward part of sharing it — it is a rule about
   * heartbeats, and the Rotom readings inherited it by living here. Rotom is
   * asked every 10s by default, so its history could in principle be finer than
   * a beat. If that is ever wanted, this is the setting that has to split.
   */
  metricsSampleSeconds: number;
  /**
   * Days of that history to keep. 0 turns recording off entirely and drops what
   * is already stored on the next prune, for a fleet that would rather not
   * spend the disk.
   */
  metricsRetentionDays: number;
  /**
   * The same two knobs again, for what Rotom says about a box rather than what
   * the box says about itself.
   *
   * Their own pair rather than sharing the metrics ones, because the two have
   * different floors and neither floor is about the other: a heartbeat sample
   * cannot usefully be finer than the heartbeat, and a Rotom sample cannot
   * usefully be finer than the Rotom sync — which is 10s by default, half a
   * beat. Sharing them meant the scanner history inherited a rule about
   * heartbeats and could never be finer than one.
   *
   * Neither is enforced as a hard floor at write time: asking for a sample
   * finer than the source simply stores every reading, which is harmless. The
   * form says so rather than the sampler refusing.
   */
  rotomSampleSeconds: number;
  /** Days of scanner history to keep. 0 records nothing, as above. */
  rotomRetentionDays: number;
  /**
   * Seconds between heartbeats, which the hub tells every box in its welcome.
   *
   * The one setting here that lives on the far side: a box only learns it on
   * its next connection, and an agent too old to read it keeps beating at 20.
   * Two other values are measured in beats, so raising this without raising
   * them is how a fleet starts flapping between online and offline — the
   * dashboard rejects that combination rather than letting it through.
   */
  heartbeatSeconds: number;
  /**
   * How many boxes may be swapping their agent binary at once. The sibling of
   * `maxConcurrentJobs`, for the other thing the whole fleet does at the same
   * time: reconnecting after a hub deploy.
   */
  agentUpdateConcurrency: number;
  /**
   * Seconds without a heartbeat before a box is marked offline. Boxes beat
   * every 20 seconds, so this is really "how many missed beats" — the default
   * is three of them plus a margin.
   */
  deviceOfflineTimeoutSeconds: number;
};

const HUB_SETTINGS_DEFAULTS: HubSettingsValues = {
  maxConcurrentJobs: 10,
  jobStallTimeoutSeconds: 900,
  metricsSampleSeconds: 60,
  metricsRetentionDays: 7,
  rotomSampleSeconds: 60,
  rotomRetentionDays: 7,
  heartbeatSeconds: 20,
  agentUpdateConcurrency: 5,
  deviceOfflineTimeoutSeconds: 70,
};

/**
 * Fleet-wide settings, in groups.
 *
 * Everything lives in the one `Setting` table, so a group is just a key
 * prefix: the hub knobs are unprefixed, because they were there first and
 * their rows are already written; anything added since carries one.
 *
 * The type check below is the part that matters. It used to be a bare
 * `typeof row.value === "number"`, which was right while every setting was a
 * number and became a silent data-loss bug the moment one was not — a string
 * webhook URL saved perfectly and then vanished on every read. Comparing
 * against the default's own type keeps that honest for whatever gets added
 * next, and doubles as the guard against a row left behind by an older shape.
 */
type SettingValue = number | string | boolean;

function mergeGroup<T extends Record<string, SettingValue>>(
  defaults: T,
  prefix: string,
  rows: { key: string; value: unknown }[],
): T {
  const values = { ...defaults };
  for (const row of rows) {
    const name = row.key.slice(prefix.length);
    if (!(name in defaults)) continue;
    if (typeof row.value !== typeof defaults[name]) continue;
    values[name as keyof T] = row.value as T[keyof T];
  }
  return values;
}

async function readGroup<T extends Record<string, SettingValue>>(
  defaults: T,
  prefix: string,
): Promise<T> {
  const keys = Object.keys(defaults).map((name) => `${prefix}${name}`);
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  return mergeGroup(defaults, prefix, rows);
}

async function writeGroup<T extends Record<string, SettingValue>>(
  patch: Partial<T>,
  prefix: string,
): Promise<void> {
  const entries = Object.entries(patch) as [string, SettingValue][];
  if (entries.length === 0) return;

  await prisma.$transaction(
    entries.map(([name, value]) =>
      prisma.setting.upsert({
        where: { key: `${prefix}${name}` },
        update: { value },
        create: { key: `${prefix}${name}`, value },
      }),
    ),
  );
}

/**
 * Always a read. The caller caches if it has reason to.
 *
 * This used to hold a copy, which was wrong in a way that took a while to
 * show: the dashboard and the hub are separate processes, and inside Next the
 * page and the server action do not reliably share module state either. So a
 * save wrote the new value, cleared the copy it could reach, and the page went
 * on rendering the copy it could not — the setting looked like it reverted to
 * the default while the database held the new number.
 *
 * The hub is the only process with a reason to cache: its scheduler reads
 * these on every tick. It does that in `services/hubSettings.ts`, where it can
 * also be told to drop the copy, which is the piece that makes caching safe.
 */
export async function getHubSettings(): Promise<HubSettingsValues> {
  return readGroup(HUB_SETTINGS_DEFAULTS, "");
}

export async function updateHubSettings(patch: Partial<HubSettingsValues>): Promise<void> {
  await writeGroup(patch, "");
}

// ---------------------------------------------------------------------------
// Monitoring settings
// ---------------------------------------------------------------------------

/**
 * The knobs behind Settings → Monitoring.
 *
 * A separate group from the hub settings above, under a `monitor.` prefix,
 * because these are read by one service rather than by everything and because
 * several of them are not numbers. They are what stands between a useful
 * watchdog and a fleet that reboots itself in a loop, so most of what is here
 * is a ceiling rather than a feature.
 */
export type MonitorSettingsValues = {
  /** The master switch. Off, so upgrading a fleet changes nothing by itself. */
  enabled: boolean;
  /**
   * Seconds between asking Rotom what it thinks of every box.
   *
   * Ignored entirely when the Rotom integration is off. When it is on, this is
   * the resolution of everything Rotom-shaped: the Scanner column, and the
   * `ROTOM_DISCONNECTED` signal below.
   *
   * Ten, matching what Rotom's own dashboard and Rotomonitor settled on — both
   * poll it every five. One request answers for the whole fleet, so the cost is
   * one HTTP round trip per interval however many boxes there are. What does
   * scale with the fleet is the row written per matched box, and that is on its
   * own grid: history is kept on `metricsSampleSeconds`, not on this.
   */
  rotomSyncSeconds: number;
  /**
   * Seconds since Rotom last saw a box before that counts as disconnected.
   * Measured against `rotomSyncSeconds` above, since a box cannot be known to
   * be fresher than the last time anyone asked.
   */
  rotomStaleSeconds: number;
  /**
   * No action on a box for this long after we rebooted it. Without this, a box
   * taking three minutes to come back reads as unreachable and gets rebooted
   * again, forever.
   */
  rebootGraceSeconds: number;
  /**
   * Nothing acts for this long after the hub starts.
   *
   * The hub runs under `tsx watch` in development, so every file save restarts
   * it and drops every device socket at once. Without this, editing this
   * repository reboots the fleet.
   */
  startupGraceSeconds: number;
  /** Circuit breaker: past this, a box is alerted about and left alone. */
  maxActionsPerDeviceHour: number;
  /** The same, for the expensive half of the ladder. */
  maxRebootsPerDeviceDay: number;
  /** The same signal on the same box is not re-announced inside this. */
  alertDedupeMinutes: number;
  /** Days of monitor history to keep. 0 keeps it forever. */
  eventRetentionDays: number;
  /** Empty turns notifications off while leaving remediation running. */
  discordWebhookUrl: string;
  /** A role to ping on CRITICAL only. Empty pings nobody. */
  discordMentionRoleId: string;
  /**
   * The ntfy server to publish to. Defaulted rather than empty because
   * ntfy.sh is what almost everyone means, and a self-hosted one is the
   * exception -- so the topic below is the field that decides whether ntfy is
   * on at all.
   */
  ntfyUrl: string;
  /** The topic. Empty turns ntfy off however the server URL is set. */
  ntfyTopic: string;
  /**
   * Bearer token for a protected topic. Empty publishes anonymously, which is
   * what a public ntfy.sh topic wants -- and is also why a topic worth
   * protecting needs a name nobody guesses.
   */
  ntfyToken: string;
  /**
   * Web push to the browsers that subscribed.
   *
   * Off by default and useless without a VAPID keypair in the hub's
   * environment -- unlike a webhook or a topic, there is nothing an operator
   * can paste into a form that turns this on, so the switch is separate from
   * the credential.
   */
  webPushEnabled: boolean;
};

const MONITOR_SETTINGS_DEFAULTS: MonitorSettingsValues = {
  enabled: false,
  rotomSyncSeconds: 10,
  rotomStaleSeconds: 600,
  rebootGraceSeconds: 600,
  startupGraceSeconds: 180,
  maxActionsPerDeviceHour: 4,
  maxRebootsPerDeviceDay: 6,
  alertDedupeMinutes: 30,
  eventRetentionDays: 30,
  discordWebhookUrl: "",
  discordMentionRoleId: "",
  ntfyUrl: "https://ntfy.sh",
  ntfyTopic: "",
  ntfyToken: "",
  webPushEnabled: false,
};

/**
 * The notification channels a rule can announce to.
 *
 * Here rather than in the hub because three things need the same list and the
 * same ids: the hub sends, the dashboard renders the picker, and the rule rows
 * store them. Ids are what is written to the database, so they are frozen --
 * the labels beside them are not.
 */
export const MONITOR_CHANNELS = ["discord", "ntfy", "webPush"] as const;
export type MonitorChannel = (typeof MONITOR_CHANNELS)[number];

export const MONITOR_CHANNEL_LABELS: Record<MonitorChannel, string> = {
  discord: "Discord",
  ntfy: "ntfy",
  webPush: "Web push",
};

/**
 * Read a rule's `notifyChannels` column.
 *
 * An empty array is a real answer -- "act, say nothing" -- so it survives.
 * Anything *unreadable* becomes every channel instead: a column that has been
 * hand-edited, written by an older version, or corrupted is a bug, and of the
 * two ways to get it wrong, a fleet that shouts is recoverable and a fleet
 * that has gone quiet without saying so is the failure this whole subsystem
 * exists to avoid.
 */
export function parseNotifyChannels(value: unknown): MonitorChannel[] {
  if (!Array.isArray(value)) return [...MONITOR_CHANNELS];
  const known = new Set<string>(MONITOR_CHANNELS);
  return value.filter(
    (entry): entry is MonitorChannel => typeof entry === "string" && known.has(entry),
  );
}

export const MONITOR_SETTINGS_PREFIX = "monitor.";

export async function getMonitorSettings(): Promise<MonitorSettingsValues> {
  return readGroup(MONITOR_SETTINGS_DEFAULTS, MONITOR_SETTINGS_PREFIX);
}

export async function updateMonitorSettings(patch: Partial<MonitorSettingsValues>): Promise<void> {
  await writeGroup(patch, MONITOR_SETTINGS_PREFIX);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/// Prisma returns BigInt for byte counts, which `JSON.stringify` refuses to
/// serialize and React refuses to render. Every byte count we store fits in a
/// double (a 9 PB device would be a surprise), so widen them on the way out.
export function serialize<T>(value: T): SerializedBigInt<T> {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? Number(v) : v)),
  ) as SerializedBigInt<T>;
}

export type SerializedBigInt<T> = T extends bigint
  ? number
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? SerializedBigInt<U>[]
      : T extends object
        ? { [K in keyof T]: SerializedBigInt<T[K]> }
        : T;
