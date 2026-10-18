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
 * Provider id Better Auth gives email/password accounts. Anything that writes a
 * credential row — the seed, the admin account form — has to use it, because
 * sign-in looks the account up by (providerId, accountId).
 */
export const CREDENTIAL_PROVIDER_ID = "credential";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Device and enrollment tokens are 32 random bytes, so a plain sha256 is
/// enough to store them — there is nothing to brute-force. Passwords use
/// bcrypt instead.
/**
 * The note on every rollout a box joining its group is given.
 *
 * Shared because two places read it back: the rollout list shows it, and the
 * Machines pages find a new container's installs by it, to show them as the
 * last stage of its setup.
 */
export const JOIN_ROLLOUT_NOTE = "joined its group";

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
 *
 * There is one account in Magnemite: nothing else creates a user and there is
 * no sign-up. So a changed `ADMIN_EMAIL` is a *rename*, which is why the
 * account is looked up by its credential row and not by email — upserting on
 * email left the old admin behind, still valid with the old password. Renaming
 * in place also keeps the sessions, the push subscriptions and the rollout
 * history attached to it.
 */
export async function syncAdminFromEnv(): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.ADMIN_PASSWORD ?? "change-me-please";
  // Hashed before the transaction opens: bcrypt at cost 12 is deliberately
  // slow, and none of it needs to hold a database transaction open.
  const passwordHash = await bcrypt.hash(password, 12);

  const duplicates = await prisma.$transaction(async (tx) => {
    const admins = await tx.user.findMany({
      where: { role: "ADMIN", accounts: { some: { providerId: CREDENTIAL_PROVIDER_ID } } },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true },
    });

    // The oldest row is the original account; anything after it is a duplicate
    // left by an `ADMIN_EMAIL` change made while this still upserted by email.
    // A hand-made OPERATOR or VIEWER is not an admin and is left alone.
    const [current, ...stale] = admins;

    // Deleted before the rename, not after, so a duplicate still holding the
    // new address cannot collide with `User.email`'s unique index — and so the
    // account that survives is always the original one, with its name, its
    // sessions and its rollout history, rather than whichever row happened to
    // own the address. Sessions and push subscriptions cascade away with the
    // duplicates; rollouts they started keep their history and lose only the
    // attribution, because `Rollout.createdById` is SetNull.
    for (const user of stale) await tx.user.delete({ where: { id: user.id } });

    // `name` is only set on create: the account may have been given a better
    // one since, and changing the address should not reset it.
    const admin = current
      ? await tx.user.update({
          where: { id: current.id },
          data: { email, emailVerified: true, role: "ADMIN" },
        })
      : await tx.user.create({
          data: {
            email,
            name: "Admin",
            emailVerified: true,
            role: "ADMIN",
          },
        });

    // Better Auth keeps credentials on the account row, not the user. The auth
    // config points its hasher at bcrypt precisely so this can create/update
    // the admin without importing Better Auth here.
    const credential = await tx.account.findFirst({
      where: { userId: admin.id, providerId: CREDENTIAL_PROVIDER_ID },
    });

    if (credential) {
      await tx.account.update({
        where: { id: credential.id },
        data: { password: passwordHash },
      });
    } else {
      await tx.account.create({
        data: {
          userId: admin.id,
          providerId: CREDENTIAL_PROVIDER_ID,
          accountId: admin.id,
          password: passwordHash,
        },
      });
    }

    return stale;
  });

  for (const user of duplicates) {
    console.warn(`admin sync: removed the duplicate admin ${user.email}`);
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
   * How long a box that has just come up waits before its group's join
   * installs start, measured from its boot.
   *
   * A container that has just enrolled is a minute-old Android, still
   * compiling its own packages and still settling Magisk, and a 170 MB game
   * pushed into the middle of that is how the first install of a box's life
   * became its flakiest. Only the join installs wait -- a rollout somebody
   * started is somebody choosing now -- and 0 turns the wait off.
   */
  joinInstallDelaySeconds: number;
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
   * How many boxes may have their MITM config rewritten at once, because the
   * workers they are configured for changed.
   *
   * The third of the "boxes at once" knobs, for the third thing the whole
   * fleet can be asked to do together: one save of the worker count in the
   * Redroid settings moves every container that follows it. Each rewrite
   * restarts that box's scanner, so this is how much of the fleet stops
   * scanning at the same moment -- low, and the cost of keeping it low is only
   * how long the change takes to reach everyone.
   */
  configRewriteConcurrency: number;
  /**
   * Seconds without a heartbeat before a box is marked offline. Boxes beat
   * every 20 seconds, so this is really "how many missed beats" — the default
   * is three of them plus a margin.
   */
  deviceOfflineTimeoutSeconds: number;
  /**
   * How long to keep the record of lost contact with a box.
   *
   * Longer than the metric history by default, and deliberately: a box that
   * drops once a week is a pattern you only see with weeks to look at, and
   * one row per episode costs nothing next to one row per beat.
   */
  connectionRetentionDays: number;
};

const HUB_SETTINGS_DEFAULTS: HubSettingsValues = {
  maxConcurrentJobs: 10,
  jobStallTimeoutSeconds: 900,
  joinInstallDelaySeconds: 120,
  metricsSampleSeconds: 60,
  metricsRetentionDays: 7,
  rotomSampleSeconds: 60,
  rotomRetentionDays: 7,
  heartbeatSeconds: 20,
  agentUpdateConcurrency: 5,
  configRewriteConcurrency: 4,
  deviceOfflineTimeoutSeconds: 70,
  connectionRetentionDays: 30,
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
 *
 * A list of strings is the one shape `typeof` cannot tell apart — an array,
 * an object and a JSON `null` are all "object" — so a list-valued setting is
 * checked for what it actually is instead.
 */
type SettingValue = number | string | boolean | string[];

function sameShape(value: unknown, fallback: SettingValue): boolean {
  if (Array.isArray(fallback)) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  return typeof value === typeof fallback;
}

function mergeGroup<T extends Record<string, SettingValue>>(
  defaults: T,
  prefix: string,
  rows: { key: string; value: unknown }[],
): T {
  const values = { ...defaults };
  for (const row of rows) {
    const name = row.key.slice(prefix.length);
    if (!(name in defaults)) continue;
    if (!sameShape(row.value, defaults[name] as SettingValue)) continue;
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
// Redroid settings
// ---------------------------------------------------------------------------

/**
 * The knobs behind Settings -> Redroid, under a `redroid.` prefix.
 *
 * A third group rather than more hub settings, following how `monitor.` is
 * already split out: these are read by one service, and they are about machines
 * rather than about the fleet.
 *
 * Deliberately *not* here: how many instances a machine runs. That is per
 * machine and lives on its rows, so the database is the one source of truth for
 * it and the backup covers it. These are the defaults a new instance inherits
 * and the arithmetic the form suggests with.
 */
export type RedroidSettingsValues = {
  /**
   * What each container is capped at, in bytes.
   *
   * The single most consequential default: without a limit a box reads the
   * host's total and every container on a machine reports the same RAM. The
   * host reports back what docker actually applied so a miss is visible rather
   * than silent.
   */
  memLimitBytes: number;
  /** androidboot.redroid_gpu_mode. "guest" is software rendering. */
  gpuMode: string;
  /**
   * How many containers may be started at once during a converge.
   *
   * `docker compose up` starts every service simultaneously, and ten Androids
   * coming up together is where a VPS runs out of memory. Low, because it only
   * costs time on a first provisioning -- the same reason the fleet has a cap
   * on concurrent installs.
   */
  startBatchSize: number;
  /**
   * Workers one container is configured for, and the ceiling the form refuses
   * above.
   *
   * 50 is where the scanners stop being happy, and on some licences it is also
   * the contractual maximum. It is the whole reason a machine needs several
   * containers rather than one big one.
   */
  workersPerInstance: number;
  /**
   * Workers per vCPU the capacity suggestion assumes.
   *
   * A planning coefficient, not a limit: the form suggests with it and warns
   * past it, and nothing refuses on it.
   *
   * Calibrated against the one self-consistent datum in the published sizing
   * advice: a 16 vCPU / 32 GB arm64 machine at "about 300 workers at full
   * speed". That is 18.75 per vCPU, so 20 puts that machine at six containers
   * of fifty -- which is where it lands on the memory half too, and two
   * independent routes agreeing is the only reason to trust either.
   *
   * Do not "correct" this to a single-digit number. An earlier draft used 2.5,
   * which put that same reference machine at **zero** containers.
   */
  workersPerVCpu: number;
  /**
   * Memory to leave the machine itself, in bytes.
   *
   * Subtracted before dividing by the per-container limit, because a machine
   * whose every byte is handed to containers has nothing left for the kernel,
   * docker or the agent -- and the OOM killer takes a container down rather
   * than slowing anything.
   */
  hostReserveBytes: number;
};

const REDROID_SETTINGS_PREFIX = "redroid.";

const REDROID_SETTINGS_DEFAULTS: RedroidSettingsValues = {
  memLimitBytes: 4 * 1024 * 1024 * 1024,
  gpuMode: "guest",
  startBatchSize: 2,
  workersPerInstance: 50,
  workersPerVCpu: 20,
  hostReserveBytes: 2 * 1024 * 1024 * 1024,
};

export async function getRedroidSettings(): Promise<RedroidSettingsValues> {
  return readGroup(REDROID_SETTINGS_DEFAULTS, REDROID_SETTINGS_PREFIX);
}

export async function updateRedroidSettings(patch: Partial<RedroidSettingsValues>): Promise<void> {
  await writeGroup(patch, REDROID_SETTINGS_PREFIX);
}

// The name template helpers live in their own module so a client component
// can import them without this one's PrismaClient coming with them, and are
// re-exported here so server code reaches them where it reaches everything
// else.
// Extensionless, and that extension is the whole story of one broken deploy.
//
// This package resolves with `moduleResolution: "bundler"`, where a relative
// specifier carries no extension. `./instance-name.js` is the NodeNext
// convention and there is no such file on disk -- `tsc` substitutes the
// extension and says nothing, and so does esbuild, so the mistake survives
// every check this repo runs. Next's webpack resolves it literally and fails
// with `Module not found: Can't resolve './instance-name.js'`, and because
// `src/lib/auth.ts` imports this module, the failure lands on *every* page
// rather than on the one that wanted a name template.
//
// It is also why `pnpm typecheck` could not catch it. The web tsconfig
// includes `.next/types/**/*.ts`, so a checkout with no `.next` typechecks
// strictly less than the build does.
export * from "./instance-name";

/**
 * How many containers a machine can hold, and what it would cost.
 *
 * Suggests rather than decides. The memory half is a real ceiling -- past it
 * the OOM killer takes boxes down instead of slowing them -- and the CPU half
 * is a planning coefficient, so the two are returned separately and the caller
 * says which one bit.
 */
export function planCapacity(
  settings: RedroidSettingsValues,
  cpuCount: number | null,
  memTotalBytes: bigint | null,
): { byMemory: number | null; byCpu: number | null; suggested: number | null } {
  const byMemory =
    memTotalBytes === null
      ? null
      : Math.max(
          0,
          Math.floor((Number(memTotalBytes) - settings.hostReserveBytes) / settings.memLimitBytes),
        );

  const byCpu =
    cpuCount === null
      ? null
      : Math.max(0, Math.floor((cpuCount * settings.workersPerVCpu) / settings.workersPerInstance));

  const both = [byMemory, byCpu].filter((n): n is number => n !== null);
  // The lower of the two, because a machine is limited by whichever runs out
  // first -- and in practice that is memory, which is why that half is a real
  // ceiling and this one is advice. Null only when the machine has reported
  // neither, which is a host that has not heartbeated yet rather than a
  // machine with no room.
  return { byMemory, byCpu, suggested: both.length === 0 ? null : Math.min(...both) };
}

/**
 * The workers one container is configured for: its own number, else its
 * machine's, else the fleet's.
 *
 * Resolved at the moment it is read and never copied down, which is the whole
 * point. A copy written onto each row at scale time is how changing the
 * setting used to move nothing at all.
 */
export function resolveWorkers(
  instance: number | null | undefined,
  host: number | null | undefined,
  settings: Pick<RedroidSettingsValues, "workersPerInstance">,
): number {
  return instance ?? host ?? settings.workersPerInstance;
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
  /** Days of monitor history to keep. 0 keeps it forever. */
  eventRetentionDays: number;
  /**
   * Grab a box's logs automatically when it comes back from a real outage.
   *
   * Off by default, and deliberately: it runs a collection on boxes in
   * somebody's living room and costs their uplink. The house rule is that
   * anything which touches the fleet on its own initiative ships switched off
   * and somebody reads it first.
   *
   * What it buys is the one thing the dashboard could never offer — the
   * window that explains an unreachable alert. The box's agent.log survives
   * the gap on its own disk; both of the tools that could fetch it need the
   * box online, which is exactly what it was not.
   */
  autoCollectLogsOnRecovery: boolean;
  /** At most one automatic capture per box in this window. */
  autoCollectMinIntervalMinutes: number;
  /**
   * Fleet-wide ceiling per hour.
   *
   * A VPS outage brings every box back at once, and fifty simultaneous
   * logcat dumps and uploads would be a second outage on top of the first.
   */
  autoCollectMaxPerHour: number;
  // Where alerts go used to live here as well: the three channels' settings
  // and the repeat window. They moved to the `notify.` group below when
  // monitoring stopped being the only thing that announces -- a rollout
  // finishing has nothing to do with a watchdog, and it reads the same webhook.
};

const MONITOR_SETTINGS_DEFAULTS: MonitorSettingsValues = {
  enabled: false,
  rotomSyncSeconds: 10,
  rotomStaleSeconds: 600,
  rebootGraceSeconds: 600,
  startupGraceSeconds: 180,
  maxActionsPerDeviceHour: 4,
  maxRebootsPerDeviceDay: 6,
  autoCollectLogsOnRecovery: false,
  autoCollectMinIntervalMinutes: 60,
  autoCollectMaxPerHour: 10,
  eventRetentionDays: 30,
};

export const MONITOR_SETTINGS_PREFIX = "monitor.";

export async function getMonitorSettings(): Promise<MonitorSettingsValues> {
  return readGroup(MONITOR_SETTINGS_DEFAULTS, MONITOR_SETTINGS_PREFIX);
}

export async function updateMonitorSettings(patch: Partial<MonitorSettingsValues>): Promise<void> {
  await writeGroup(patch, MONITOR_SETTINGS_PREFIX);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * The knobs behind Settings → Notifications, under a `notify.` prefix.
 *
 * Their own group because two different things announce now: the monitor,
 * about a box gone wrong, and the fleet itself, about a rollout finishing or a
 * build that would not download. Both go out through the same three channels,
 * so the channels belong to neither of them.
 *
 * These rows used to be `monitor.*`; the migration that split them out is a
 * rename, and the defaults are the ones they always had.
 */
export type NotifySettingsValues = {
  /** Empty turns Discord off while everything else keeps running. */
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
  /**
   * The same monitor signal on the same box is not re-announced inside this.
   *
   * Monitor alerts only. A fleet event is announced on a transition -- a
   * rollout finishes once -- so there is nothing for a window to hold back.
   */
  alertDedupeMinutes: number;
};

const NOTIFY_SETTINGS_DEFAULTS: NotifySettingsValues = {
  discordWebhookUrl: "",
  discordMentionRoleId: "",
  ntfyUrl: "https://ntfy.sh",
  ntfyTopic: "",
  ntfyToken: "",
  webPushEnabled: false,
  alertDedupeMinutes: 30,
};

export const NOTIFY_SETTINGS_PREFIX = "notify.";

export async function getNotifySettings(): Promise<NotifySettingsValues> {
  return readGroup(NOTIFY_SETTINGS_DEFAULTS, NOTIFY_SETTINGS_PREFIX);
}

export async function updateNotifySettings(patch: Partial<NotifySettingsValues>): Promise<void> {
  await writeGroup(patch, NOTIFY_SETTINGS_PREFIX);
}

/**
 * The channels anything can announce to.
 *
 * Here rather than in the hub because three things need the same list and the
 * same ids: the hub sends, the dashboard renders the pickers, and both the
 * monitor rules and the event routes below store them. Ids are what is written
 * to the database, so they are frozen -- the labels the dashboard shows beside
 * them are not.
 */
export const NOTIFY_CHANNELS = ["discord", "ntfy", "webPush"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * Read a stored list of channels: a rule's `notifyChannels` column, or an
 * event's route.
 *
 * An empty array is a real answer -- "act, say nothing" -- so it survives.
 * Anything *unreadable* becomes every channel instead: a column that has been
 * hand-edited, written by an older version, or corrupted is a bug, and of the
 * two ways to get it wrong, a fleet that shouts is recoverable and a fleet
 * that has gone quiet without saying so is the failure this whole subsystem
 * exists to avoid.
 */
export function parseNotifyChannels(value: unknown): NotifyChannel[] {
  if (!Array.isArray(value)) return [...NOTIFY_CHANNELS];
  const known = new Set<string>(NOTIFY_CHANNELS);
  return value.filter(
    (entry): entry is NotifyChannel => typeof entry === "string" && known.has(entry),
  );
}

/**
 * The fleet events that can be announced, in the order the dashboard lists
 * them, and whether each is on for a fleet that never touched the setting.
 *
 * The ids are setting keys -- `notify.event.<id>` -- so they are frozen the
 * same way the channel ids are. What each one says and when it fires is the
 * hub's (`services/fleetEvents.ts`); what the dashboard calls it is the web's.
 *
 * Everything is on by default except the one that is chatty by nature: a
 * channel nobody has set up sends nothing anyway, so "on" costs a fleet with
 * no channels nothing, and a fleet that does have one asked to be told.
 */
export const NOTIFY_EVENTS = [
  { id: "rolloutAutoStarted", on: true },
  { id: "rolloutStarted", on: true },
  { id: "rolloutSucceeded", on: true },
  { id: "rolloutFailed", on: true },
  { id: "rolloutPaused", on: true },
  { id: "buildDiscovered", on: false },
  { id: "buildCacheFailed", on: true },
  { id: "sourceFailing", on: true },
  { id: "machineReady", on: true },
  { id: "machineSetupFailed", on: true },
  { id: "convergeFailed", on: true },
  { id: "joinInstallFailed", on: true },
  { id: "agentUpdateFailed", on: true },
] as const;

export type NotifyEventId = (typeof NOTIFY_EVENTS)[number]["id"];

export const NOTIFY_EVENT_IDS: NotifyEventId[] = NOTIFY_EVENTS.map((event) => event.id);

/** Which channels each fleet event goes to. An empty list is "off". */
export type NotifyRoutes = Record<NotifyEventId, NotifyChannel[]>;

const NOTIFY_ROUTES_PREFIX = "notify.event.";

const NOTIFY_ROUTES_DEFAULTS = Object.fromEntries(
  NOTIFY_EVENTS.map((event) => [event.id, event.on ? [...NOTIFY_CHANNELS] : []]),
) as Record<NotifyEventId, string[]>;

/**
 * The event routes, one row per event.
 *
 * A group of its own under `notify.event.`, read through `readGroup` like
 * every other: an event added in a later version arrives with its default,
 * and a row for an event that no longer exists is simply never asked for.
 */
export async function getNotifyRoutes(): Promise<NotifyRoutes> {
  const stored = await readGroup(NOTIFY_ROUTES_DEFAULTS, NOTIFY_ROUTES_PREFIX);
  return Object.fromEntries(
    NOTIFY_EVENT_IDS.map((id) => [id, parseNotifyChannels(stored[id])]),
  ) as NotifyRoutes;
}

export async function updateNotifyRoutes(patch: Partial<NotifyRoutes>): Promise<void> {
  await writeGroup(patch, NOTIFY_ROUTES_PREFIX);
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
