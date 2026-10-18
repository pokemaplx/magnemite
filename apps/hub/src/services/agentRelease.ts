import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServerMessage } from "@magnemite/protocol";
import { getHubSettings, prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { getConnection, listConnections } from "../registry.js";
import { announceAgentUpdateFailed } from "./fleetEvents.js";
import { ACTIVE_STATES } from "./jobs.js";
import { inMaintenance } from "./maintenance.js";

/**
 * Agent self-updates, driven by the hub.
 *
 * The hub image is built with the agent binaries in it (see apps/hub/Dockerfile)
 * and the VERSION they came from. On boot those are copied into the artifact
 * directory, which is the volume the edge already serves `/files/*` from behind
 * the device token — so a box downloads its new binary exactly the way it
 * downloads an .apkm, and Node stays out of the data path.
 *
 * A box that reconnects on an older version is then told to update itself.
 * Deploying the hub is the whole release: nothing is uploaded by hand, no
 * checksum is copied around, and a box that was powered off for a month
 * catches up the moment it dials in.
 */

type Build = { file: string; url: string; sha256: string };

type Release = { version: string; builds: Map<string, Build> };

/** Subdirectory of ARTIFACT_DIR the binaries are published under. */
/**
 * Where published agent artifacts live under ARTIFACT_DIR.
 *
 * Shared with boxEnroll.ts, which publishes the Magisk module zip into the
 * *same* versioned directory -- `pruneOldReleases` deletes every other
 * directory under here, so a zip published anywhere else would vanish on the
 * next boot.
 */
export const PUBLISH_DIR = "agent";

let release: Release | null = null;

/**
 * Which build an ABI gets. Android reports the primary ABI in
 * `ro.product.cpu.abi`; anything we do not cross-compile for simply never
 * gets an update rather than getting the wrong binary.
 */
function buildKeyForAbi(abi: string | null | undefined): string | null {
  if (!abi) return null;
  if (abi.startsWith("arm64")) return "arm64";
  if (abi.startsWith("armeabi") || abi === "arm") return "arm";
  return null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

/**
 * Publish the binaries this image carries and remember their checksums.
 *
 * Called once at boot. A missing AGENT_BIN_DIR is not an error: a hub built
 * without the Go stage, or running from source in development, simply has no
 * agent release to hand out and auto-update stays off.
 */
export async function loadAgentRelease(): Promise<Release | null> {
  if (!env.AGENT_AUTO_UPDATE) {
    log.info("agent auto-update is off");
    return null;
  }

  const dir = env.AGENT_BIN_DIR;
  const version = await fs
    .readFile(path.join(dir, "VERSION"), "utf8")
    .then((v) => v.trim())
    .catch(() => null);
  if (!version) {
    log.warn({ dir }, "no agent release in this image — auto-update disabled");
    return null;
  }

  // Versioned path: a box mid-download when the hub is redeployed keeps
  // pulling the file it started on rather than getting a different binary
  // under the same URL and failing its checksum.
  const publishDir = path.join(env.ARTIFACT_DIR, PUBLISH_DIR, version);
  await fs.mkdir(publishDir, { recursive: true });

  const builds = new Map<string, Build>();
  for (const key of ["arm64", "arm"]) {
    const name = `magnemite-agent-linux-${key}`;
    const source = path.join(dir, name);
    const exists = await fs
      .stat(source)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists) continue;

    const sha256 = await sha256File(source);
    const dest = path.join(publishDir, name);
    // Republishing on every boot would rewrite a file a box may be reading.
    // Only copy when the published one is missing or is not this build.
    const published = await sha256File(dest).catch(() => null);
    if (published !== sha256) await fs.copyFile(source, dest);

    builds.set(key, {
      file: dest,
      url: `${env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, "")}/files/${PUBLISH_DIR}/${version}/${name}`,
      sha256,
    });
  }

  if (builds.size === 0) {
    log.warn({ dir }, "agent release has no binaries — auto-update disabled");
    return null;
  }

  await pruneOldReleases(version);

  release = { version, builds };
  log.info({ version, builds: [...builds.keys()] }, "agent release published");
  return release;
}

/**
 * Drop binaries from earlier releases. ~6 MB a version is not much, but this
 * directory would otherwise grow forever on a long-lived volume. A box that
 * was mid-download of the old binary fails its next chunk and is simply told
 * to update again — to the current version — when it reconnects.
 */
async function pruneOldReleases(current: string) {
  const root = path.join(env.ARTIFACT_DIR, PUBLISH_DIR);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current) continue;
    await fs
      .rm(path.join(root, entry.name), { recursive: true, force: true })
      .catch(() => undefined);
  }
}

export function agentTargetVersion(): string | null {
  return release?.version ?? null;
}

/**
 * Boxes told to update and not yet seen on the new version. Bounded by
 * the concurrent-agent-updates setting, so a fleet-wide version bump rolls through in
 * batches instead of all at once.
 *
 * Each entry remembers which agent process was told -- the `agentStartedAt`
 * of its hello, null from an agent too old to report one -- because that is
 * what tells an update still on its way apart from one that is not coming.
 */
type PendingUpdate = { sentAt: number; agentStartedAt: number | null };
const inFlight = new Map<string, PendingUpdate>();
/** A box that never comes back releases its slot rather than holding it. */
const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

function reapInFlight() {
  const cutoff = Date.now() - IN_FLIGHT_TTL_MS;
  for (const [deviceId, pending] of inFlight) {
    if (pending.sentAt < cutoff) inFlight.delete(deviceId);
  }
}

export function releaseAgentUpdateSlot(deviceId: string) {
  inFlight.delete(deviceId);
}

export function agentUpdatesInFlight(): number {
  reapInFlight();
  return inFlight.size;
}

/**
 * Whether an update sent to this box may still be on its way.
 *
 * The scheduler holds the box's jobs while it may: the swap ends in a re-exec,
 * and an install the box had started in the meantime dies with the process.
 *
 * "This box" is the agent process that was told, when the agent says which one
 * it is -- a socket that dropped and came back mid-download is still the same
 * download. An agent too old to say is judged by its socket instead: an update
 * sent before that socket connected is over, because a box that reconnected on
 * its old version was not updated, and holding its jobs until the slot expires
 * would hold them ten minutes for nothing.
 */
export function agentUpdateInFlight(conn: {
  deviceId: string;
  connectedAt: number;
  agentStartedAt: number | null;
}): boolean {
  reapInFlight();
  const pending = inFlight.get(conn.deviceId);
  if (!pending) return false;
  if (pending.agentStartedAt !== null && conn.agentStartedAt !== null) {
    return pending.agentStartedAt === conn.agentStartedAt;
  }
  return pending.sentAt >= conn.connectedAt;
}

/**
 * Decide whether this box should update right now, and send it if so.
 *
 * Called on every hello. The agent itself refuses to swap its binary mid-job,
 * but checking here too keeps a busy box out of the concurrency budget.
 */
/**
 * Close the open attempts for a box. Called when the box comes back on the new
 * version, when the agent says the swap failed, and when the hub can tell an
 * update is not coming.
 *
 * The newest open row gets the outcome. An older one still open is an attempt
 * that never landed and was overtaken, and is closed as that: left SENT, it
 * read as "updating" for as long as anyone cared to look, and the next sweep
 * then closed it as a success -- the eleven-minute "done" beside the
 * one-second one that had actually done it.
 */
async function finishAgentUpdate(
  deviceId: string,
  state: "SUCCESS" | "FAILED",
  opts: { version?: string; error?: string } = {},
) {
  const [latest, ...older] = await prisma.agentUpdate.findMany({
    where: {
      deviceId,
      state: "SENT",
      ...(opts.version ? { toVersion: opts.version } : {}),
    },
    orderBy: { sentAt: "desc" },
    select: { id: true, sentAt: true },
  });
  if (!latest) return;

  await prisma.agentUpdate.update({
    where: { id: latest.id },
    data: { state, error: opts.error ?? null, finishedAt: new Date() },
  });
  if (older.length > 0) {
    await supersede(
      deviceId,
      latest.sentAt,
      older.map((row) => row.id),
    );
  }
  bus.publish({ kind: "device", deviceId });
}

/**
 * Close attempts that a later one overtook, as of the moment it did. Only rows
 * still SENT: one the agent answered keeps the answer it gave.
 */
async function supersede(deviceId: string, at: Date, ids?: string[]) {
  await prisma.agentUpdate.updateMany({
    where: { deviceId, state: "SENT", ...(ids ? { id: { in: ids } } : {}) },
    data: { state: "FAILED", error: "never landed; a later attempt was sent", finishedAt: at },
  });
}

/** The agent could not swap its binary and said why. */
export async function recordAgentUpdateFailure(
  deviceId: string,
  version: string,
  error: string | null,
) {
  releaseAgentUpdateSlot(deviceId);
  await finishAgentUpdate(deviceId, "FAILED", {
    version,
    error: error ?? "the agent reported a failure with no detail",
  });
  log.warn({ deviceId, version, error }, "agent update failed on the box");
  // Only here, where the agent said so. The other FAILED rows in this file
  // are the hub's own inferences -- a restart before the swap, an update set
  // aside for a job -- and are retried without anything being wrong.
  announceAgentUpdateFailed(deviceId, version, error);
}

/**
 * Async only because the concurrency cap is a live setting now — every other
 * decision here is local state. Neither caller uses the result.
 */
export async function maybeUpdateAgent(
  device: {
    id: string;
    abi: string | null;
    agentVersion: string | null;
    currentJobId: string | null;
    /** Which agent process this is, from its hello. Null from an old agent. */
    agentStartedAt: number | null;
  },
  send: (msg: ServerMessage) => void,
): Promise<boolean> {
  if (!release) return false;
  // Already there — and this is also how a box that just updated frees its
  // slot and closes its history row.
  if (device.agentVersion === release.version) {
    const wasUpdating = inFlight.delete(device.id);
    void finishAgentUpdate(device.id, "SUCCESS", { version: release.version }).catch((err) =>
      log.error({ err, deviceId: device.id }, "could not close agent update"),
    );
    if (wasUpdating) log.info({ deviceId: device.id, version: release.version }, "agent updated");
    return false;
  }

  // An update already out to this box that is not going to land. Neither case
  // is ever reported by the agent, and both used to hold the slot for the full
  // ten minutes it lives -- the slot being exactly what stops the box being
  // told again, so the retry that then worked in a second waited out the lot.
  const pending = inFlight.get(device.id);
  if (pending) {
    const restarted =
      pending.agentStartedAt !== null &&
      device.agentStartedAt !== null &&
      pending.agentStartedAt !== device.agentStartedAt;
    if (restarted) {
      // A different agent process is answering, still on the old binary: the
      // one that was told went down before it swapped. Told again below, now.
      inFlight.delete(device.id);
      void finishAgentUpdate(device.id, "FAILED", {
        error: `the agent restarted on ${device.agentVersion ?? "its old version"} before swapping`,
      }).catch((err) => log.error({ err, deviceId: device.id }, "could not close agent update"));
    } else if (device.currentJobId) {
      // Running a job, and an agent never swaps under one: it set the update
      // aside, which an agent of this vintage does without a word. Released
      // so the sweep asks again once the box is idle.
      inFlight.delete(device.id);
      void finishAgentUpdate(device.id, "FAILED", {
        error: "set aside: the box was running a job, and is asked again once it is idle",
      }).catch((err) => log.error({ err, deviceId: device.id }, "could not close agent update"));
      return false;
    }
  }
  if (device.currentJobId) return false;

  const key = buildKeyForAbi(device.abi);
  const build = key ? release.builds.get(key) : null;
  if (!build) {
    log.warn({ deviceId: device.id, abi: device.abi }, "no agent build for this ABI");
    return false;
  }

  reapInFlight();
  if (inFlight.has(device.id)) return false;

  const { agentUpdateConcurrency } = await getHubSettings();
  if (inFlight.size >= agentUpdateConcurrency) return false;

  // A box somebody is working on is not a box to swap the agent binary under:
  // a self-update drops the socket and comes back as a different process, in
  // the middle of whatever they are doing.
  //
  // Read here rather than at the top of the function, and deliberately: this
  // is the only branch that acts, so the query costs one read per update
  // rather than one per box per sweep. The connection cannot answer it either
  // — it is held in memory from the box's hello and would be stale the moment
  // somebody parked the box.
  //
  // The same read asks whether the hub has a job out to the box. The agent's
  // own word is `currentJobId`, but that is a heartbeat old, and a job sent a
  // moment ago is one it has not mentioned yet: the agent would defer the
  // update -- it never swaps under a running install -- and this box would
  // sit in `inFlight` with nothing coming, its jobs held behind it.
  const row = await prisma.device.findUnique({
    where: { id: device.id },
    select: {
      maintenanceUntil: true,
      jobs: { where: { state: { in: ACTIVE_STATES } }, select: { id: true }, take: 1 },
    },
  });
  if (row && inMaintenance(row)) return false;
  if (row && row.jobs.length > 0) return false;
  // And once more after the last await, where nothing can come between the
  // check and the send: the scheduler's dispatch is the same kind of block,
  // so one of the two always sees the other.
  const live = getConnection(device.id);
  if (live?.currentJobId || live?.pushingConfig) return false;

  const sentAt = new Date();
  inFlight.set(device.id, { sentAt: sentAt.getTime(), agentStartedAt: device.agentStartedAt });
  send({ type: "agent_update", url: build.url, sha256: build.sha256, version: release.version });
  const toVersion = release.version;
  void (async () => {
    // One open attempt per box. Anything still open here never landed -- its
    // slot expired, or the hub restarted and forgot it -- and this one is what
    // overtook it.
    await supersede(device.id, sentAt);
    await prisma.agentUpdate.create({
      data: { deviceId: device.id, fromVersion: device.agentVersion, toVersion, sentAt },
    });
    bus.publish({ kind: "device", deviceId: device.id });
  })().catch((err) => log.error({ err, deviceId: device.id }, "could not record agent update"));
  log.info(
    { deviceId: device.id, from: device.agentVersion, to: release.version },
    "agent update sent",
  );
  return true;
}

/**
 * Second chance for boxes that were skipped at hello — busy with a job, or
 * over the batch limit while the fleet converges. Without this a box that
 * never disconnects would stay on an old agent until it happened to reboot.
 */
const SWEEP_MS = 60_000;
let sweepTimer: NodeJS.Timeout | null = null;

export function startAgentUpdateSweep() {
  if (sweepTimer || !release) return;
  sweepTimer = setInterval(() => {
    for (const conn of listConnections()) {
      void maybeUpdateAgent(
        {
          id: conn.deviceId,
          abi: conn.abi,
          agentVersion: conn.agentVersion,
          currentJobId: conn.currentJobId,
          agentStartedAt: conn.agentStartedAt,
        },
        conn.send,
      ).catch((err) => log.error({ err, deviceId: conn.deviceId }, "agent update check failed"));
    }
  }, SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopAgentUpdateSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
