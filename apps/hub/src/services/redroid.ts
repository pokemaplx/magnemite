import { createHash, randomUUID } from "node:crypto";
import type { HostConvergeResult, HostInfo } from "@magnemite/protocol";
import { generateToken, getRedroidSettings, hashToken, prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { getConnection, sendTo } from "../registry.js";
import { composeServiceName, renderCompose } from "./redroidCompose.js";
import { execOnDevice } from "./deviceCommands.js";
import { REDROID_IMAGE } from "../version.js";

/**
 * The last host report per machine, in memory.
 *
 * Deliberately not a table: it is what the machine said a moment ago, and the
 * parts worth keeping are already written to rows. Adoption is the one thing
 * that needs the raw list, because it has to see containers the hub has no rows
 * for yet — which is precisely what cannot be read back out of the rows.
 *
 * Lost on a hub restart, which costs one heartbeat before adoption is possible
 * again. `services/monitor.ts` keeps its live readings the same way, for the
 * same reason.
 */
const lastReport = new Map<string, HostInfo>();

/**
 * What a machine reports about itself, and about the containers on it.
 *
 * The machine's own readings — CPU, memory, swap, disk, load — are not here:
 * a host is a Device, so they go through `applyMetrics` like any box's and end
 * up in the same table, drawn by the same chart. This is only the half a box
 * has no equivalent of.
 */

/** Capped well under MariaDB's 64 KB TEXT, and under the 1 MB frame limit. */
const MAX_ERROR_CHARS = 8_000;

/**
 * The container state for an instance docker has no container for.
 *
 * Not one of docker's own words — docker has nothing to say about a container
 * that does not exist — and deliberately not null, which this project reserves
 * for "nothing has looked". The dashboard needs no case for it: the instances
 * table draws any state that is not `running` as a fault, under its own name.
 */
export const ABSENT = "absent";

/**
 * Keeps the head and the tail of an oversized error.
 *
 * Both ends matter and the middle rarely does: docker names what it was doing
 * first and why it failed last. A plain truncation keeps the part nobody reads.
 */
export function clampError(text: string): string {
  if (text.length <= MAX_ERROR_CHARS) return text;
  const half = Math.floor((MAX_ERROR_CHARS - 40) / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n… ${dropped} characters dropped …\n${text.slice(-half)}`;
}

function toBigInt(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(Math.trunc(value));
}

/**
 * Single-quoted for the host's shell, the one way that cannot be escaped out of.
 *
 * The project name and directory are the hub's own, not operator free text, so
 * this is belt rather than braces — but it is one line and the alternative is
 * trusting that forever.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Starts the containers a machine is supposed to be running and is not.
 *
 * This is all `RESTART_INSTANCE` does, and it is deliberately the narrowest
 * command that could work. Three refusals are built into the command itself
 * rather than checked for afterwards:
 *
 *  - **a running container is not touched**, because `--no-recreate` says so.
 *    Recreating one would cost a healthy box a full Android cold boot for its
 *    neighbour's fault.
 *  - **nothing is removed**, because `--remove-orphans` is absent. This can
 *    never become the destructive converge that adoption exists to prevent.
 *  - **the machine is never rebooted.** That would take every box on it down
 *    for one box's fault, which is exactly what this action exists instead of.
 *
 * An instance whose state is unknown is left alone too. Null means nothing has
 * looked, and acting on silence is what the whole monitor refuses to do.
 */
export async function startDownInstances(
  deviceId: string,
): Promise<{ ok: boolean; detail: string | null }> {
  const host = await prisma.redroidHost.findUnique({
    where: { deviceId },
    select: {
      project: true,
      dir: true,
      instances: {
        where: { present: true },
        select: { index: true, containerState: true },
      },
    },
  });
  if (!host) return { ok: false, detail: "not a machine" };

  const down = host.instances
    .filter((row) => row.containerState !== null && row.containerState !== "running")
    .map((row) => composeServiceName(row.index))
    .sort();
  // Nothing to do rather than a failure to report: the signal is read per beat
  // and the container may have come back between the reading and the ladder.
  if (down.length === 0) return { ok: true, detail: "nothing was down by the time this ran" };

  const command =
    `docker compose --project-directory ${quote(host.dir)} -p ${quote(host.project)} ` +
    `up -d --no-recreate ${down.join(" ")}`;

  const outcome = await execOnDevice(deviceId, command, 300).catch((err: unknown) => ({
    ok: false,
    output: "",
    error: err instanceof Error ? err.message : String(err),
  }));
  return {
    ok: outcome.ok,
    detail: outcome.ok
      ? `started ${down.join(", ")}`
      : clampError(outcome.error ?? outcome.output).slice(0, 400),
  };
}

/**
 * Whether docker answered this machine's last report, as three answers.
 *
 * `null` is "this hub has not heard from the machine", which is what a restart
 * leaves behind for one heartbeat and what a box gives always. `false` is the
 * one worth having: the agent is up, it asked docker for its version, and
 * nothing came back.
 *
 * Read from the live report rather than from `RedroidHost.dockerVersion`,
 * because that column deliberately keeps the last version it ever saw — a
 * newer agent must not have its finding wiped by an older one, which is the
 * same `?? undefined` rule the whole report follows. The column is history; a
 * daemon being down is right now.
 */
export function dockerAnswered(deviceId: string): boolean | null {
  const report = lastReport.get(deviceId);
  if (!report) return null;
  return Boolean(report.dockerVersion);
}

/**
 * Stores one host report.
 *
 * Every field is optional and absent means "this agent did not say", never
 * zero — the same rule the device metrics follow, and the reason the Go side
 * sends pointers. `?? undefined` leaves whatever was last known in place,
 * because an agent that has not learned to report docker's version must not
 * wipe the version a newer one found.
 */
export async function applyHostReport(deviceId: string, host: HostInfo): Promise<void> {
  lastReport.set(deviceId, host);
  try {
    // Upserted because the satellite may not exist yet: a machine that
    // enrolled against an older hub, or one whose row was never created.
    await prisma.redroidHost.upsert({
      where: { deviceId },
      create: {
        deviceId,
        arch: host.arch ?? null,
        kernel: host.kernel ?? null,
        dockerVersion: host.dockerVersion ?? null,
        binderOk: host.binderOk ?? null,
        appliedSha256: host.composeSha256 ?? null,
      },
      update: {
        arch: host.arch ?? undefined,
        kernel: host.kernel ?? undefined,
        dockerVersion: host.dockerVersion ?? undefined,
        binderOk: host.binderOk ?? undefined,
        // The hash the machine read back off its own disk, which is what the
        // next converge decision is made against. Only overwritten when the
        // machine actually reported one.
        appliedSha256: host.composeSha256 ?? undefined,
      },
    });

    await applyContainers(deviceId, host);
  } catch (err) {
    // A host report is nice to have; a machine's heartbeat is not. The same
    // trade `recordSample` makes, and for the same reason: losing a reading
    // must never cost a machine its liveness.
    log.warn({ err, deviceId }, "failed to store host report");
  }
}

/**
 * Matches reported containers to instance rows and stores what docker saw.
 *
 * Matched **by serial**, read back off the container's own command line, and
 * not by name or by index. A name is derived from an index and an index can be
 * reused; the serial is the identity the box enrolls under, so it is the only
 * thing that cannot quietly point at a different box.
 *
 * A container with no matching row is left alone rather than invented. That is
 * what adoption is for, and doing it here would mean a machine could create
 * instance rows by reporting them — which is also how a hand-written compose
 * file would silently become managed.
 */
async function applyContainers(deviceId: string, host: HostInfo): Promise<void> {
  // Docker could not be asked at all, so this report says nothing about
  // containers — which is emphatically not the same as a machine with none.
  // The agent's contract: it reads docker's version first and returns early
  // with nothing further when there is no answer, so an empty version is the
  // reading. Without this gate a machine whose daemon died would have every
  // one of its instances marked absent, which is the hub inventing a fault.
  if (!host.dockerVersion) return;

  const bySerial = new Map(
    host.containers.filter((c) => c.serial).map((c) => [c.serial as string, c]),
  );

  // Every instance that is *supposed* to be here, not just the ones reported.
  // The difference is the whole point: a container destroyed outside Magnemite
  // simply stops appearing, and matching only what was reported would leave
  // that row saying `running` for as long as the machine stayed up.
  const rows = await prisma.redroidInstance.findMany({
    where: { hostId: deviceId, present: true },
    select: { id: true, serial: true, containerState: true, restartCount: true },
  });

  // Whether anything a page shows moved, so the dashboard is told once, after
  // the rows are written. The heartbeat's own event fires before this runs,
  // and a page refreshed on it raced these writes -- a container that came up
  // read as absent for another twenty seconds.
  let changed = false;
  const now = new Date();
  for (const row of rows) {
    const container = bySerial.get(row.serial);
    if (!container) {
      // Docker answered and this one was not in the answer, so it does not
      // exist. A state of its own rather than null: null means "nothing has
      // looked", and something did look. The converge is what creates it, and
      // a machine mid-converge is left alone by the monitor for that reason.
      if (row.containerState === ABSENT) continue;
      await prisma.redroidInstance.update({
        where: { id: row.id },
        data: { containerState: ABSENT, reportedAt: now },
      });
      changed = true;
      continue;
    }
    if (
      row.containerState !== container.state ||
      (container.restartCount != null && row.restartCount !== container.restartCount)
    ) {
      changed = true;
    }
    await prisma.redroidInstance.update({
      where: { id: row.id },
      data: {
        containerState: container.state,
        restartCount: container.restartCount ?? undefined,
        // What docker says it *applied*, against which the asked-for limit is
        // checked. A silent miss here would have every box on the machine
        // reporting the whole machine's RAM.
        appliedMemLimitBytes: toBigInt(container.memLimitBytes) ?? undefined,
        reportedAt: now,
      },
    });
  }
  if (changed) bus.publish({ kind: "device", deviceId });
}

// ---------------------------------------------------------------------------
// Scaling, adoption and converging
// ---------------------------------------------------------------------------

/**
 * The serial a container will enrol under.
 *
 * Derived from the host's immutable id and the index, so it is deterministic,
 * globally unique, and survives a rename -- deriving it from the machine's name
 * would re-identify every box on it the moment somebody renamed the machine,
 * and a changed serial is a new box with no history.
 *
 * Minted once at row creation and never recomputed, so this is only ever
 * called for a row that does not exist yet.
 */
export function mintSerial(hostId: string, index: number): string {
  // The tail of a cuid, which is the random half. The leading characters are a
  // timestamp and are near-identical across rows created together.
  const suffix = hostId.slice(-6);
  return `rd-${suffix}-${String(index).padStart(2, "0")}`;
}

/**
 * The memory ceiling every container on one machine is given.
 *
 * Per machine rather than fleet-wide because that is where the hardware is.
 * The number in Settings is sized for a machine that holds several containers,
 * and lowering it so a 4 GB VPS fits one would hand that same smaller ceiling
 * to every machine that did not need it. This is the override the compose
 * renderer has always read — `instance ?? host ?? settings` — with nothing
 * until now able to write the middle one.
 *
 * Null clears it and goes back to inheriting Settings.
 *
 * Takes effect on the next converge and not before: this is `mem_limit` in the
 * rendered file, and docker applies it when the container is created. The
 * caller converges, so a Save that changes only this still recreates them.
 */
export async function setHostMemLimit(hostId: string, bytes: bigint | null): Promise<void> {
  await prisma.redroidHost.update({
    where: { deviceId: hostId },
    data: { memLimitBytes: bytes },
  });
}

/**
 * The workers every container on one machine is configured for, unless it has
 * a number of its own.
 *
 * Null clears it and goes back to following Settings, which is the state worth
 * being in: a machine on the fleet's number moves when that number does.
 *
 * Nothing is rendered from it -- workers reach a box through its MITM config,
 * not the compose file -- so it recreates no container. The configs of the
 * boxes it moves are rewritten by `workersConfig.ts`, a few at a time.
 */
export async function setHostWorkers(hostId: string, workers: number | null): Promise<void> {
  await prisma.redroidHost.update({
    where: { deviceId: hostId },
    data: { workers },
  });
}

/**
 * Brings a machine to `count` instances.
 *
 * Adds at the lowest free index and removes from the tail, and never
 * renumbers: removing index 3 of ten leaves a gap that the next scale-up
 * refills. Closing the gap would rewrite serials, and a changed serial is a new
 * box with a new row and no history.
 *
 * Removal marks `present: false` rather than deleting, so re-adding that index
 * brings the same box back with everything it had. Deleting is what "forget"
 * does, and it is a different button.
 *
 * Touches no worker count. It used to write the form's number onto every
 * present row, which is what made a container with a number of its own
 * impossible -- the next Save flattened it -- and what left a whole machine on
 * a stale copy of the setting. New rows inherit, and so follow the machine.
 */
export async function setInstanceCount(
  hostId: string,
  count: number,
): Promise<{ added: number; removed: number }> {
  const present = await prisma.redroidInstance.findMany({
    where: { hostId, present: true },
    orderBy: { index: "asc" },
    select: { id: true },
  });

  let added = 0;
  let removed = 0;

  if (count < present.length) {
    // From the tail, which is the only choice that does not surprise: an
    // operator scaling 10 down to 7 means "three fewer", and taking them from
    // the middle would stop whichever boxes happened to sort there.
    const doomed = present.slice(count).map((row) => row.id);
    const result = await prisma.redroidInstance.updateMany({
      where: { id: { in: doomed } },
      data: { present: false },
    });
    removed = result.count;
  } else if (count > present.length) {
    added = await placeInstances(hostId, count - present.length, undefined);
  }

  if (added > 0 || removed > 0) bus.publish({ kind: "device", deviceId: hostId });
  return { added, removed };
}

/**
 * Adds `howMany` containers, each configured for `workers`.
 *
 * The other door to a scale-up, for containers that are not meant to be like
 * their neighbours: two at thirty on a machine of fifties are added here in
 * one step, rather than by scaling up and then editing two rows -- in between
 * which the new boxes would already be enrolling on the wrong number.
 *
 * Null inherits the machine's number, exactly as a scale-up would.
 */
export async function addInstances(
  hostId: string,
  howMany: number,
  workers: number | null,
): Promise<{ added: number }> {
  const added = await placeInstances(hostId, howMany, workers);
  if (added > 0) bus.publish({ kind: "device", deviceId: hostId });
  return { added };
}

/**
 * The allocator both doors share: the lowest free index first, and an index
 * that was removed comes back as itself.
 *
 * `workers` undefined leaves a revived row's own number where it was -- a
 * scale-up brings back the same box with everything it had -- while null or a
 * number is an answer somebody just gave, and is written.
 */
async function placeInstances(
  hostId: string,
  howMany: number,
  workers: number | null | undefined,
): Promise<number> {
  const rows = await prisma.redroidInstance.findMany({
    where: { hostId },
    select: { id: true, index: true, present: true },
  });
  const byIndex = new Map(rows.map((row) => [row.index, row]));

  let added = 0;
  for (let index = 1; added < howMany; index += 1) {
    const existing = byIndex.get(index);
    if (existing?.present) continue;
    if (existing) {
      // Removed, so it comes back with the serial it always had -- which is
      // what makes a removal recoverable.
      await prisma.redroidInstance.update({
        where: { id: existing.id },
        data: {
          present: true,
          ...(workers === undefined ? {} : { workers }),
          requestedAt: new Date(),
          // What it said before it was removed is about a container that
          // has since been destroyed. Unknown until the machine reports the
          // new one, rather than a stale `running` that was never this one.
          containerState: null,
          restartCount: null,
          reportedAt: null,
        },
      });
    } else {
      await prisma.redroidInstance.create({
        data: {
          hostId,
          index,
          serial: mintSerial(hostId, index),
          workers: workers ?? null,
          requestedAt: new Date(),
        },
      });
    }
    added += 1;
  }
  return added;
}

/**
 * Imports the containers a machine already has as instance rows.
 *
 * This exists so the first converge is not destructive. A machine running the
 * hand-written compose file has containers holding real device identities; with
 * no instance rows the desired set is empty, every one of them is an orphan,
 * and `--remove-orphans` would drop every box on it.
 *
 * Matched by the serial read off each container's own command line, so an
 * adopted box keeps the `Device` row it already enrolled as.
 */
export async function adoptHost(deviceId: string): Promise<{ adopted: number }> {
  const host = await prisma.redroidHost.findUnique({
    where: { deviceId },
    select: { adoptedAt: true },
  });
  if (!host) throw new Error("that machine has not enrolled yet");
  if (host.adoptedAt) return { adopted: 0 };

  // What the machine last told us it was holding. Read from the instance rows'
  // absence rather than from a live query: adoption acts on the report that
  // arrived with the last heartbeat, which is the only thing the hub has.
  const conn = getConnection(deviceId);
  if (!conn) throw new Error("that machine is offline; adoption needs its report");

  const reported = lastReport.get(deviceId);
  if (!reported) throw new Error("no host report yet; wait for the next heartbeat");

  let adopted = 0;
  for (const container of reported.containers) {
    if (!container.serial) continue;
    const index = indexFromName(container.name);
    if (index === null) continue;
    // Skip an index already taken, rather than overwriting it: a collision
    // means the hub and the machine disagree, and guessing which is right is
    // how a box loses its identity.
    const clash = await prisma.redroidInstance.findFirst({
      where: { hostId: deviceId, OR: [{ index }, { serial: container.serial }] },
      select: { id: true },
    });
    if (clash) continue;

    const device = await prisma.device.findUnique({
      where: { serial: container.serial },
      select: { id: true },
    });
    await prisma.redroidInstance.create({
      data: {
        hostId: deviceId,
        index,
        serial: container.serial,
        deviceId: device?.id ?? null,
        containerState: container.state,
        reportedAt: new Date(),
      },
    });
    adopted += 1;
  }

  await prisma.redroidHost.update({
    where: { deviceId },
    data: { adoptedAt: new Date() },
  });
  return { adopted };
}

/**
 * The trailing number in a container name, which is its index.
 *
 * Null when there is none, and the container is then left alone rather than
 * given an index of its own: a name this cannot read is a container Magnemite
 * did not create, and inventing a row for it would make a stranger managed.
 */
function indexFromName(name: string): number | null {
  const match = /(\d+)$/.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 1 ? index : null;
}

/**
 * Sends a machine the compose file its rows describe, if it needs one.
 *
 * Fire and forget. A converge is minutes of image pulls and Android boots, so
 * awaiting it over an HTTP request would hold the dashboard's connection open
 * for half an hour; `convergingSince` is what lets the page say so instead.
 * The result arrives on the socket and lands in `recordConvergeResult`.
 *
 * Returns what it decided and why, because "nothing happened" has several
 * causes an operator needs told apart: the machine is offline, it has not been
 * adopted, or it is already exactly right.
 */
export async function convergeHost(
  deviceId: string,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; reason?: string }> {
  const host = await prisma.redroidHost.findUnique({
    where: { deviceId },
    include: {
      instances: {
        where: { present: true },
        select: { index: true, serial: true, memLimitBytes: true, cpuset: true, image: true },
      },
    },
  });
  if (!host) return { sent: false, reason: "that machine has not enrolled yet" };

  // Nothing is converged before adoption. A machine running the hand-written
  // compose file has containers holding real device identities, and an empty
  // desired set would make every one of them an orphan.
  if (!host.adoptedAt) {
    return {
      sent: false,
      reason: "adopt this machine first — it may already be running containers",
    };
  }
  if (!getConnection(deviceId)) {
    // Not an error: the rows are the desired state, and the machine converges
    // when it comes back. Said out loud so nobody is left wondering -- and
    // written down, because the hello that brings it back is what keeps that
    // promise, and it only sends what is owed.
    await prisma.redroidHost.update({
      where: { deviceId },
      data: { convergeOwedAt: new Date() },
    });
    return { sent: false, reason: "offline — it will converge when it reconnects" };
  }

  const token = await hostEnrollToken(deviceId);
  const settings = await getRedroidSettings();
  const compose = renderCompose(
    {
      project: host.project,
      // The hub URL the boxes dial, which is never the dashboard's — the one
      // value that has broken every deployment of this at least once.
      serverUrl: env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, ""),
      enrollToken: token,
      image: host.image ?? REDROID_IMAGE,
      memLimitBytes: host.memLimitBytes ?? BigInt(settings.memLimitBytes),
      cpuset: host.cpuset,
      gpuMode: host.gpuMode ?? settings.gpuMode,
    },
    host.instances,
  );

  const sha256 = createHash("sha256").update(compose).digest("hex");
  // The machine already has exactly these bytes. Sending them again would
  // recreate nothing, but the operator would still watch a converge run for no
  // reason.
  if (!options.force && host.appliedSha256 === sha256) {
    // Nothing is owed to a machine that already has it.
    if (host.convergeOwedAt) {
      await prisma.redroidHost.update({ where: { deviceId }, data: { convergeOwedAt: null } });
    }
    return { sent: false, reason: "already up to date" };
  }

  const requestId = randomUUID();
  const ok = sendTo(deviceId, {
    type: "host_converge",
    requestId,
    project: host.project,
    dir: host.dir,
    compose,
    batchSize: settings.startBatchSize,
    // Only once a machine has converged before. A first converge may not remove
    // anything, because anything it would remove predates Magnemite managing
    // this machine at all.
    removeOrphans: host.appliedSha256 !== null,
  });
  if (!ok) return { sent: false, reason: "could not reach that machine" };

  await prisma.redroidHost.update({
    where: { deviceId },
    data: { convergingSince: new Date(), convergeOwedAt: null, lastError: null, lastErrorAt: null },
  });
  bus.publish({ kind: "device", deviceId });
  log.info({ deviceId, requestId, services: host.instances.length }, "converge dispatched");
  return { sent: true };
}

/**
 * How long a converge may be taken to still be running. The agent gives each
 * wave of `docker compose up` half an hour; past that, a `convergingSince`
 * still set is a result that was lost on the way back, not work in progress.
 */
export const CONVERGE_STALE_MS = 30 * 60 * 1000;

/**
 * Sends a machine that has just said hello the converge it is owed, if any.
 *
 * What `convergeHost` promises an offline machine -- "it will converge when it
 * reconnects" -- and nothing used to do. It mattered most where nobody would
 * think to look: a machine provisioned with instances is adopted the moment
 * it enrols, over HTTP and before its socket exists, so the converge that was
 * meant to bring its first containers up was always refused as offline.
 *
 * Only an owed one (`convergeOwedAt`), never "whatever differs": a hub deploy
 * that changes the rendered compose file must not recreate every container on
 * every machine as they reconnect. And never alongside one still running --
 * the agent's survives a dropped socket, and a second would rewrite the
 * compose file under the first.
 */
export async function convergeOnReconnect(deviceId: string): Promise<void> {
  const host = await prisma.redroidHost.findUnique({
    where: { deviceId },
    select: { convergingSince: true, convergeOwedAt: true },
  });
  if (!host?.convergeOwedAt) return;
  if (host.convergingSince && Date.now() - host.convergingSince.getTime() < CONVERGE_STALE_MS) {
    return;
  }
  const result = await convergeHost(deviceId);
  log.info({ deviceId, sent: result.sent, reason: result.reason }, "owed converge on reconnect");
}

/** Stores what a machine did about a converge. */
export async function recordConvergeResult(
  deviceId: string,
  result: HostConvergeResult,
): Promise<void> {
  const failed = !result.ok;
  await prisma.redroidHost
    .update({
      where: { deviceId },
      data: {
        convergingSince: null,
        // Written whenever the machine read one back, including on a failure:
        // the file *is* on disk at that point, and saying otherwise would have
        // the hub send the same bytes again on every reconnect, forever.
        ...(result.composeSha256 ? { appliedSha256: result.composeSha256 } : {}),
        ...(result.ok ? { appliedAt: new Date() } : {}),
        lastError: failed ? clampError(convergeError(result)) : null,
        lastErrorAt: failed ? new Date() : null,
      },
    })
    .catch((err) => log.warn({ err, deviceId }, "failed to store the converge result"));
  bus.publish({ kind: "device", deviceId });

  log.info({ deviceId, requestId: result.requestId, ok: result.ok }, "converge reported");
}

/** The error plus docker's own output, which is usually where the reason is. */
function convergeError(result: HostConvergeResult): string {
  const parts = [result.error, result.output].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : "the machine reported a failure with no detail";
}

/**
 * Tokens minted this process lifetime, in plaintext.
 *
 * The hub stores only hashes, so this is the one place a machine's own token
 * exists in the clear — and it has to exist somewhere, because every render of
 * that machine's compose file must contain the same token or its hash would
 * change and recreate every container.
 *
 * A hub restart loses it and the next converge mints a fresh one, revoking the
 * old. That costs the containers nothing: the agent reads the token only when
 * it has no device token of its own.
 */
const mintedTokens = new Map<string, string>();

/**
 * The enrollment token this machine's containers use.
 *
 * One per machine rather than one shared across the fleet, so a leaked compose
 * file or a compromised machine is revoked in one click without re-tokening
 * every other machine.
 *
 * `kind: BOX`, because this is the token the containers *inside* use — the
 * machine itself enrolled with a HOST one, which is a different thing and must
 * not be reusable here.
 */
async function hostEnrollToken(deviceId: string): Promise<string> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { name: true },
  });
  const label = `host: ${device?.name ?? deviceId}`;

  const existing = await prisma.enrollmentToken.findFirst({
    where: { label, kind: "BOX", revoked: false },
    select: { id: true },
  });
  const minted = mintedTokens.get(deviceId);
  if (existing && minted) return minted;

  // Either there is no token, or the hub restarted and lost the plaintext of
  // the one there is. Revoke it, so a compose file nobody can read any more
  // cannot enrol anything either.
  if (existing) {
    await prisma.enrollmentToken.update({ where: { id: existing.id }, data: { revoked: true } });
  }
  const token = generateToken();
  await prisma.enrollmentToken.create({
    data: {
      label,
      tokenHash: hashToken(token),
      prefix: token.slice(0, 8),
      kind: "BOX",
      autoApprove: true,
    },
  });
  mintedTokens.set(deviceId, token);
  return token;
}
