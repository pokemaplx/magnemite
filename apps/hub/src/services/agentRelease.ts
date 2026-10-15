import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServerMessage } from "@magnemite/protocol";
import { getHubSettings, prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { listConnections } from "../registry.js";
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
const PUBLISH_DIR = "agent";

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

async function sha256File(file: string): Promise<string> {
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
 */
const inFlight = new Map<string, number>();
/** A box that never comes back releases its slot rather than holding it. */
const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

function reapInFlight() {
  const cutoff = Date.now() - IN_FLIGHT_TTL_MS;
  for (const [deviceId, startedAt] of inFlight) {
    if (startedAt < cutoff) inFlight.delete(deviceId);
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
 * Decide whether this box should update right now, and send it if so.
 *
 * Called on every hello. The agent itself refuses to swap its binary mid-job,
 * but checking here too keeps a busy box out of the concurrency budget.
 */
/**
 * Close the open attempt for a box, if there is one. Called when the box comes
 * back on the new version, and when the agent says the swap failed.
 *
 * Only the newest open row is closed: an attempt that was never answered stays
 * SENT rather than being retroactively marked as something it was not.
 */
async function finishAgentUpdate(
  deviceId: string,
  state: "SUCCESS" | "FAILED",
  opts: { version?: string; error?: string } = {},
) {
  const open = await prisma.agentUpdate.findFirst({
    where: {
      deviceId,
      state: "SENT",
      ...(opts.version ? { toVersion: opts.version } : {}),
    },
    orderBy: { sentAt: "desc" },
    select: { id: true },
  });
  if (!open) return;

  await prisma.agentUpdate.update({
    where: { id: open.id },
    data: { state, error: opts.error ?? null, finishedAt: new Date() },
  });
  bus.publish({ kind: "device", deviceId });
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
  const parked = await prisma.device.findUnique({
    where: { id: device.id },
    select: { maintenanceUntil: true },
  });
  if (parked && inMaintenance(parked)) return false;

  inFlight.set(device.id, Date.now());
  send({ type: "agent_update", url: build.url, sha256: build.sha256, version: release.version });
  void prisma.agentUpdate
    .create({
      data: {
        deviceId: device.id,
        fromVersion: device.agentVersion,
        toVersion: release.version,
      },
    })
    .then(() => bus.publish({ kind: "device", deviceId: device.id }))
    .catch((err) => log.error({ err, deviceId: device.id }, "could not record agent update"));
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
