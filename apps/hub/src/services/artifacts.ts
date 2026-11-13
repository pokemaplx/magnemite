import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { announceBuildCacheFailed } from "./fleetEvents.js";

/**
 * One artifact downloads at a time. The VPS pulling 250 MB while 10 devices
 * are pulling 170 MB each off the same uplink is how a rollout starts timing
 * out, so caching gets the queue to itself.
 */
let cacheChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = cacheChain.then(fn, fn);
  cacheChain = next.catch(() => undefined);
  return next;
}

export function artifactFilename(
  packageName: string,
  version: string,
  arch: string,
  source: string,
): string {
  return `${packageName}_${arch}_${version}_${source.toLowerCase()}.apkm`;
}

export async function ensureArtifactDir() {
  await fs.mkdir(env.ARTIFACT_DIR, { recursive: true });
}

export function cacheVersion(versionId: string) {
  return enqueue(() => doCacheVersion(versionId));
}

async function doCacheVersion(versionId: string) {
  const version = await prisma.appVersion.findUnique({
    where: { id: versionId },
    include: { appTarget: true },
  });
  if (!version) throw new Error("version not found");
  if (version.status === "READY" && version.artifactPath) {
    // Verify it is still on disk — the volume may have been wiped.
    const exists = await fs
      .stat(version.artifactPath)
      .then(() => true)
      .catch(() => false);
    if (exists) return version;
  }

  await ensureArtifactDir();
  const filename = artifactFilename(
    version.appTarget.packageName,
    version.version,
    version.arch,
    version.source,
  );
  const finalPath = path.join(env.ARTIFACT_DIR, filename);
  const tmpPath = `${finalPath}.part`;

  await prisma.appVersion.update({
    where: { id: versionId },
    data: { status: "CACHING", cacheProgress: 0, error: null },
  });
  bus.publish({ kind: "version", versionId });
  log.info({ versionId, url: version.remoteUrl }, "caching artifact");

  try {
    const total = Number(version.sizeBytes);

    // Resume a partial download if the hub restarted mid-transfer.
    let already = await fs
      .stat(tmpPath)
      .then((s) => s.size)
      .catch(() => 0);

    // A partial file at least as long as the remote one is not partial: an
    // earlier attempt wrote all of it and then failed verification, or the
    // feed replaced the build with a smaller one. Resuming would ask for a
    // range past the end of the file and be refused with a 416, so start
    // over — and do the same when the server is the one saying so.
    if (total > 0 && already >= total) already = 0;

    const fetchFrom = (offset: number) => {
      const headers: Record<string, string> = { "User-Agent": "magnemite-hub" };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      return fetch(version.remoteUrl, { headers, redirect: "follow" });
    };

    let res = await fetchFrom(already);
    if (res.status === 416 && already > 0) {
      already = 0;
      res = await fetchFrom(0);
    }
    if (!res.ok || !res.body) {
      throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
    }

    const resuming = res.status === 206 && already > 0;
    if (!resuming && already > 0) await fs.rm(tmpPath, { force: true });

    let received = resuming ? already : 0;
    let lastPct = -1;
    let lastReportAt = 0;

    const sha256 = createHash("sha256");
    const md5 = createHash("md5");

    if (resuming) {
      // Hashes must cover the whole file, so replay what is already on disk.
      const existing = await fs.open(tmpPath, "r");
      try {
        const stream = existing.createReadStream();
        for await (const chunk of stream) {
          sha256.update(chunk as Buffer);
          md5.update(chunk as Buffer);
        }
      } finally {
        await existing.close();
      }
    }

    const out = createWriteStream(tmpPath, { flags: resuming ? "a" : "w" });
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

    source.on("data", (chunk: Buffer) => {
      sha256.update(chunk);
      md5.update(chunk);
      received += chunk.length;
      const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
      // Write at most one row update per percent and per second: a 170 MB
      // download fires this callback tens of thousands of times.
      if (pct !== lastPct && Date.now() - lastReportAt > 1000) {
        lastPct = pct;
        lastReportAt = Date.now();
        void prisma.appVersion
          .update({ where: { id: versionId }, data: { cacheProgress: pct } })
          .then(() => bus.publish({ kind: "version", versionId }))
          .catch(() => undefined);
      }
    });

    await pipeline(source, out);

    const sha256Hex = sha256.digest("hex");
    const md5Hex = md5.digest("hex");
    const finalSize = (await fs.stat(tmpPath)).size;

    // Some sources publish an md5 and some do not; where there is none, the
    // size the index reported is the only check available.
    const mismatch =
      version.md5 && version.md5.toLowerCase() !== md5Hex
        ? `md5 mismatch: expected ${version.md5}, got ${md5Hex}`
        : total > 0 && finalSize !== total
          ? `size mismatch: expected ${total} bytes, got ${finalSize}`
          : null;
    if (mismatch) {
      // Complete but wrong. Left on disk, the next attempt would try to resume
      // it instead of downloading again.
      await fs.rm(tmpPath, { force: true });
      throw new Error(mismatch);
    }

    await fs.rename(tmpPath, finalPath);

    const updated = await prisma.appVersion.update({
      where: { id: versionId },
      data: {
        status: "READY",
        cacheProgress: 100,
        artifactPath: finalPath,
        sha256: sha256Hex,
        md5: version.md5 ?? md5Hex,
        sizeBytes: BigInt(finalSize),
        error: null,
      },
    });
    bus.publish({ kind: "version", versionId });
    log.info({ versionId, sha256: sha256Hex, bytes: finalSize }, "artifact cached");
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.appVersion.update({
      where: { id: versionId },
      data: { status: "FAILED", error: message },
    });
    bus.publish({ kind: "version", versionId });
    log.error({ err, versionId }, "artifact caching failed");
    // Worth a message where a download that worked is not: auto-update passes
    // over a FAILED build, so the next release a fleet waits for can be held
    // up here without anything else saying so.
    announceBuildCacheFailed(version, message);
    throw err;
  }
}

/** Remove cached files for versions nothing references any more. */
export async function pruneArtifacts(keepLatest = 3) {
  const targets = await prisma.appTarget.findMany({ select: { id: true } });
  let removed = 0;

  for (const target of targets) {
    const versions = await prisma.appVersion.findMany({
      where: { appTargetId: target.id, status: "READY", artifactPath: { not: null } },
      orderBy: { discoveredAt: "desc" },
      include: { _count: { select: { rollouts: true } } },
    });

    for (const version of versions.slice(keepLatest)) {
      const inUse = await prisma.job.count({
        where: {
          rollout: { appVersionId: version.id },
          state: {
            in: ["QUEUED", "DISPATCHED", "DOWNLOADING", "EXTRACTING", "INSTALLING", "VERIFYING"],
          },
        },
      });
      if (inUse > 0) continue;

      await fs.rm(version.artifactPath!, { force: true });
      await prisma.appVersion.update({
        where: { id: version.id },
        data: { status: "DISCOVERED", artifactPath: null, cacheProgress: 0 },
      });
      removed += 1;
    }
  }

  if (removed) log.info({ removed }, "pruned cached artifacts");
  return removed;
}
