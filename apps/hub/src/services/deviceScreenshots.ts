import fs from "node:fs/promises";
import path from "node:path";
import { CAPABILITY_SCREENSHOT, hasCapability } from "@magnemite/protocol";
import { prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { isOnline, sendTo } from "../registry.js";

/**
 * One look at what a box has on its screen.
 *
 * Every other reading answers a number. This answers the question those cannot:
 * a box can be online, heartbeating, with the scanner's process alive, and
 * sitting on a dialog nobody has read. `APP_NOT_FOREGROUND` says the launcher
 * owns the screen; a screenshot says *what is on it* — the login that expired,
 * the crash dialog, the update prompt, the black screen.
 *
 * Shaped like a log bundle on purpose, down to the upload route: the PNG goes
 * over HTTP with the box's own device token, because the socket caps a frame at
 * 1 MB and a 1080p capture is regularly more than that. Nothing about this
 * feature needed a new transport, which is most of why it is small.
 *
 * Deliberately **on request only**. Nothing captures on a schedule and nothing
 * captures on an alert: these are boxes in somebody's living room, and a
 * fleet-wide watcher quietly taking pictures of their televisions is not a
 * feature anybody asked for. One capture, because a person pressed a button,
 * recorded in the audit log with their name on it.
 */

/** Where captures land, under ARTIFACT_DIR. */
const SHOT_DIR = "screenshots";

/**
 * How long a box has to capture and upload.
 *
 * Shorter than a log bundle's two minutes, because `screencap` is one syscall's
 * worth of work and the browser is waiting on this one. A box that cannot do it
 * inside half a minute is a box with something else wrong.
 */
const CAPTURE_TIMEOUT_MS = 30_000;

/** How many to keep per box, and for how long. A look, not an archive. */
const KEEP_PER_DEVICE = 5;
const KEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function screenshotDir(deviceId: string): string {
  return path.join(env.ARTIFACT_DIR, SHOT_DIR, deviceId);
}

export function screenshotPath(deviceId: string, screenshotId: string): string {
  return path.join(screenshotDir(deviceId), `${screenshotId}.png`);
}

/** Whether a box's agent knows the message at all. */
export function hasScreenshot(capabilities: unknown): boolean {
  return hasCapability(capabilities, CAPABILITY_SCREENSHOT);
}

/** Waiters for captures still in flight, keyed by screenshot id. */
const pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

/**
 * Ask a box for a screenshot and wait for it.
 *
 * The wait is the same deliberate one a log bundle does: the dashboard calls
 * this and then renders the image, so there is nothing to poll and nothing to
 * come back to.
 *
 * A box in maintenance is **not** refused here, and that is the point of the
 * exception — looking at the screen is one of the reasons somebody parks a box
 * in the first place.
 */
export async function requestScreenshot(
  deviceId: string,
  requestedById: string | null,
): Promise<{ screenshotId: string }> {
  if (!isOnline(deviceId)) throw new Error("device is offline");

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { capabilities: true },
  });
  if (device && !hasScreenshot(device.capabilities)) {
    // Said here rather than discovered as a timeout. The agent's type switch
    // has no default branch, so an older one drops the frame in silence and
    // the only symptom would be half a minute of waiting.
    throw new Error(
      "this box's agent is too old to take a screenshot, and takes an agent update first",
    );
  }

  const shot = await prisma.deviceScreenshot.create({
    data: { deviceId, requestedById },
    select: { id: true },
  });

  const uploadUrl = `${env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, "")}/api/screenshots/${shot.id}`;
  const sent = sendTo(deviceId, {
    type: "collect_screenshot",
    screenshotId: shot.id,
    uploadUrl,
  });
  if (!sent) {
    await failScreenshot(shot.id, "the device went offline before the request was sent");
    throw new Error("device is offline");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(shot.id);
      void failScreenshot(shot.id, "the box did not upload anything within thirty seconds");
      reject(new Error("the box did not send a screenshot in time"));
    }, CAPTURE_TIMEOUT_MS);

    pending.set(shot.id, {
      resolve: () => {
        clearTimeout(timer);
        pending.delete(shot.id);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        pending.delete(shot.id);
        reject(err);
      },
    });
  });

  return { screenshotId: shot.id };
}

/** Called by the upload route once the PNG is on disk. */
export async function completeScreenshot(
  screenshotId: string,
  filePath: string,
  sizeBytes: number,
) {
  const shot = await prisma.deviceScreenshot.update({
    where: { id: screenshotId },
    data: {
      state: "READY",
      path: filePath,
      sizeBytes: BigInt(sizeBytes),
      error: null,
      completedAt: new Date(),
    },
    select: { deviceId: true },
  });

  pending.get(screenshotId)?.resolve();
  bus.publish({ kind: "device", deviceId: shot.deviceId });
  await prune(shot.deviceId);
}

/** The box said it could not capture or upload, or nothing arrived in time. */
export async function failScreenshot(screenshotId: string, error: string) {
  const shot = await prisma.deviceScreenshot
    .update({
      where: { id: screenshotId },
      data: { state: "FAILED", error, completedAt: new Date() },
      select: { deviceId: true },
    })
    .catch(() => null);

  pending.get(screenshotId)?.reject(new Error(error));
  if (shot) bus.publish({ kind: "device", deviceId: shot.deviceId });
}

/**
 * Keep the last few per box and nothing older than a day.
 *
 * Tighter than the log bundles' week, and on purpose: a log is evidence about
 * something that happened, and a picture of somebody's television is not worth
 * keeping once the question it answered has been answered.
 */
async function prune(deviceId: string) {
  const shots = await prisma.deviceScreenshot.findMany({
    where: { deviceId },
    orderBy: { requestedAt: "desc" },
    select: { id: true, path: true, requestedAt: true },
  });

  const cutoff = Date.now() - KEEP_MAX_AGE_MS;
  const doomed = shots.filter(
    (shot, index) => index >= KEEP_PER_DEVICE || shot.requestedAt.getTime() < cutoff,
  );
  if (doomed.length === 0) return;

  for (const shot of doomed) {
    if (shot.path) await fs.rm(shot.path, { force: true }).catch(() => undefined);
  }
  await prisma.deviceScreenshot.deleteMany({ where: { id: { in: doomed.map((s) => s.id) } } });
  log.debug({ deviceId, removed: doomed.length }, "pruned screenshots");
}
