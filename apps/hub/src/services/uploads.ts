import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { COSMOG_PACKAGE, versionFromFilename } from "@magnemite/apk";
import { readApkInfo } from "./apkInfo.js";
import { artifactFilename, ensureArtifactDir } from "./artifacts.js";
import { wrapAsBundle } from "./zip.js";

/**
 * Manual installs: an operator hands us an APK for some app on the boxes —
 * the scanner, a launcher, anything — instead of waiting for a watched source
 * to publish one.
 *
 * The upload lands here as a raw stream and comes out the far side as an
 * ordinary `AppVersion` in `READY`, which means every part downstream — the
 * scheduler, the agent, the rollout pages, retries — treats it exactly like a
 * version discovered on a source. The only thing that marks it out is
 * `source = MANUAL` and its target's `manual` flag.
 */

/** Refuse absurd uploads early: the biggest real bundle is ~250 MB. */
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export type UploadInput = {
  stream: Readable;
  /** Name the browser sent, used only to decide whether to wrap it. */
  filename: string;
  /** Left empty, the package name is read out of the file's own manifest. */
  packageName?: string | null;
  /**
   * What the operator calls this build, e.g. "1.4.2" or "2026-08-26 hotfix".
   * Left empty, the manifest's versionName is used.
   */
  version?: string | null;
  displayName?: string | null;
  arch?: string | null;
  note?: string | null;
  uploadedById?: string | null;
  /**
   * Where this came from, when there is such a place. An upload has none — the
   * artifact *is* the upload — but a build fetched from a link does, and
   * keeping it is what lets `Free old bundles` reclaim the file without the
   * version becoming unusable: Cache re-fetches it exactly like a source's.
   */
  remoteUrl?: string | null;
};

export type UploadResult = {
  appVersionId: string;
  appTargetId: string;
  packageName: string;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  wrapped: boolean;
  /** True when the package name or version came from the file, not the form. */
  detected: boolean;
};

/**
 * A version label is whatever the operator typed — "1.4.2", but also
 * "2026-08-26 hotfix". The label is kept as-is in the database; this is what
 * goes in the filename, which becomes a URL the boxes fetch.
 */
function slug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "build"
  );
}

/**
 * Bare `.apk` files are wrapped into a one-entry bundle; anything that is
 * already a multi-APK archive is stored as it arrived.
 */
function needsWrapping(filename: string): boolean {
  return path.extname(filename).toLowerCase() === ".apk";
}

/**
 * The other way a build arrives: a URL instead of a file.
 *
 * The upload path runs the bytes through the operator's browser, the
 * dashboard and whatever proxy sits in front of it, and one of those has a
 * body limit that a 250 MB bundle does not fit under — Cloudflare's free plan
 * stops at 100 MB and answers 413. Fetching server-side skips all three: the
 * bytes go from wherever they are published straight onto the artifacts
 * volume, and nothing in between has to carry them.
 *
 * Deliberately the *same* function underneath. What lands on disk, what is
 * read out of the manifest and what is written to the database is identical to
 * an upload — only the source of the stream differs.
 */
export type RemoteInput = Omit<UploadInput, "stream" | "filename"> & {
  url: string;
  /** Overrides the name taken from the URL, when the URL has nothing useful. */
  filename?: string | null;
};

/** What a link has to look like before the hub will fetch it. */
function parseRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("that is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https links can be fetched");
  }
  return url;
}

/**
 * The name to store the download under. A URL's last path segment is usually
 * the filename, and it is what decides whether a bare APK gets wrapped — so a
 * link that ends in nothing useful is treated as an .apk, which is the common
 * case and the safe one: wrapping something already a bundle is what would
 * break, and a bundle's URL says .apkm or .xapk.
 */
function filenameFromUrl(url: URL, disposition: string | null): string {
  const fromHeader = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const candidate = decodeURIComponent(
    (fromHeader ?? url.pathname.split("/").pop() ?? "").trim(),
  ).trim();
  if (/\.(apk|apkm|xapk|zip)$/i.test(candidate)) return candidate;
  return candidate ? `${candidate}.apk` : "download.apk";
}

export type ProbeResult = {
  url: string;
  status: number;
  /** Null when the server does not say — a chunked response, usually. */
  sizeBytes: number | null;
  contentType: string | null;
  filename: string;
  /** True when the server refused a HEAD and this came from a ranged GET. */
  viaRange: boolean;
};

/**
 * Ask the far end about a link without downloading it.
 *
 * Answers what is cheap to answer — is it there, how big is it, what is it
 * called. Not the version: that lives in the manifest, at the end of a zip
 * that has not been fetched yet, so it is read on import like an upload's.
 */
export async function probeRemote(rawUrl: string): Promise<ProbeResult> {
  const url = parseRemoteUrl(rawUrl);

  let res: Response;
  let viaRange = false;
  try {
    res = await fetch(url, { method: "HEAD", redirect: "follow" });
    // A fair number of file hosts answer HEAD with 403 or 405 and serve the
    // GET perfectly well. One ranged byte is enough to tell them apart.
    if (!res.ok) {
      viaRange = true;
      res = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
      await res.body?.cancel();
    }
  } catch (err) {
    throw new Error(
      `could not reach that link (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // A ranged request answers 206 and its content-length is the one byte asked
  // for; the total is in content-range.
  const range = res.headers.get("content-range");
  const total = range?.match(/\/(\d+)$/)?.[1];
  const length = total ?? res.headers.get("content-length");

  return {
    url: res.url || url.toString(),
    status: res.status,
    sizeBytes: length ? Number(length) : null,
    contentType: res.headers.get("content-type"),
    filename: filenameFromUrl(
      new URL(res.url || url.toString()),
      res.headers.get("content-disposition"),
    ),
    viaRange,
  };
}

/** Fetch a published build and store it exactly as an upload of it would be. */
export async function storeFromUrl(input: RemoteInput): Promise<UploadResult> {
  const url = parseRemoteUrl(input.url);

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw new Error(
      `could not reach that link (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`the link answered HTTP ${res.status}`);
  }

  // A link to a download *page* rather than to the file answers 200 with HTML,
  // and without this the failure surfaces 200 MB later as "could not read a
  // package name out of this file", which points at the wrong thing entirely.
  const contentType = res.headers.get("content-type") ?? "";
  if (/^text\/html/i.test(contentType)) {
    await res.body.cancel();
    throw new Error("that link returns a web page, not a file — link to the download itself");
  }

  const filename =
    input.filename?.trim() ||
    filenameFromUrl(new URL(res.url || url.toString()), res.headers.get("content-disposition"));

  log.info({ url: url.toString(), filename }, "fetching a build from a link");

  return storeUpload({
    ...input,
    filename,
    // The URL after redirects, so a re-cache goes where the bytes actually are.
    remoteUrl: res.url || url.toString(),
    // Node's fetch gives a web stream; storeUpload pipes a Node one.
    stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
  });
}

export async function storeUpload(input: UploadInput): Promise<UploadResult> {
  const typedPackage = (input.packageName ?? "").trim();
  const typedVersion = (input.version ?? "").trim();

  if (typedPackage && !PACKAGE_NAME.test(typedPackage)) {
    throw new Error(`"${typedPackage}" is not an Android package name`);
  }

  const arch = (input.arch ?? "").trim() || "arm64-v8a";
  const wrapped = needsWrapping(input.filename);

  await ensureArtifactDir();
  const stamp = Date.now().toString(36);
  const incoming = path.join(env.ARTIFACT_DIR, `upload-${stamp}.part`);

  // --- receive ------------------------------------------------------------
  let received = 0;
  try {
    input.stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) input.stream.destroy(new Error("upload is too large"));
    });
    await pipeline(input.stream, createWriteStream(incoming));
  } catch (err) {
    await fs.rm(incoming, { force: true });
    throw err;
  }

  if (received === 0) {
    await fs.rm(incoming, { force: true });
    throw new Error("the upload was empty");
  }

  // --- ask the file what it is --------------------------------------------
  // An APK carries its package and version in its manifest, so an operator
  // typing them again is an operator with a chance to get them wrong. What
  // they did type still wins: a label like "2026-08-26 hotfix" is a deliberate
  // choice the file cannot express.
  const manifest = await readApkInfo(incoming);

  // A Cosmog bundle is not an APK and has no manifest to ask. What it is can
  // be read off its entries, so the package is not the operator's to get
  // wrong; its version is in no file inside it, so that one they do type --
  // or name the file for, the way `cosmog-2.1.3.zip` does.
  const cosmog = manifest.cosmog === true;
  if (cosmog && typedPackage && typedPackage !== COSMOG_PACKAGE) {
    await fs.rm(incoming, { force: true });
    throw new Error(
      `this file is a Cosmog bundle, not a build of ${typedPackage} — choose ${COSMOG_PACKAGE} for it`,
    );
  }
  if (cosmog) manifest.versionName = versionFromFilename(input.filename);

  const packageName = cosmog ? COSMOG_PACKAGE : typedPackage || (manifest.packageName ?? "");
  // versionName is what people call a version, but it is optional in the
  // manifest — a build that only declares versionCode is still a build, and
  // the number it does have beats making the operator go and find one.
  const version = typedVersion || manifest.versionName || (manifest.versionCode ?? "");
  const detected =
    (!typedPackage && Boolean(manifest.packageName)) ||
    (!typedVersion && Boolean(manifest.versionName ?? manifest.versionCode));

  if (!PACKAGE_NAME.test(packageName)) {
    await fs.rm(incoming, { force: true });
    throw new Error(
      packageName
        ? `"${packageName}" is not an Android package name`
        : "could not read a package name out of this file — type one in",
    );
  }
  if (!version) {
    await fs.rm(incoming, { force: true });
    throw new Error(
      cosmog
        ? `a Cosmog bundle does not say which version it is — choose ${COSMOG_PACKAGE} as the package and type its version, or name the file for it (cosmog-2.1.3.zip)`
        : "could not read a version out of this file — its manifest declares neither a versionName nor a versionCode",
    );
  }

  // --- shape it like every other artifact ---------------------------------
  const filename = artifactFilename(packageName, slug(version), arch, "manual");
  const finalPath = path.join(env.ARTIFACT_DIR, filename);

  try {
    if (wrapped) {
      await wrapAsBundle(incoming, finalPath);
      await fs.rm(incoming, { force: true });
    } else {
      await fs.rename(incoming, finalPath);
    }

    const sha256 = await sha256File(finalPath);
    const { size } = await fs.stat(finalPath);

    // --- record it ---------------------------------------------------------
    const target = await prisma.appTarget.upsert({
      where: { packageName },
      update: {},
      create: {
        packageName,
        displayName:
          input.displayName?.trim() ||
          (cosmog ? "Cosmog" : packageName.split(".").pop() || packageName),
        manual: true,
        arch,
        // Nothing polls a manual target and nothing auto-updates it; uploads
        // are approved on arrival because a human just chose the file.
        enabled: true,
        autoApprove: true,
      },
    });

    // Re-uploading the same label replaces the artifact rather than failing on
    // the unique constraint — the operator fixing a bad build expects that.
    const appVersion = await prisma.appVersion.upsert({
      where: {
        appTargetId_version_arch: { appTargetId: target.id, version, arch },
      },
      update: {
        filename,
        // Re-importing the same label from a different link should follow the
        // new one, and a re-upload of a build that used to come from a link
        // should stop claiming it does.
        remoteUrl: input.remoteUrl?.trim() ?? "",
        artifactPath: finalPath,
        sizeBytes: BigInt(size),
        sha256,
        buildCode: manifest.versionCode,
        status: "READY",
        cacheProgress: 100,
        error: null,
        approved: true,
        publishedAt: new Date(),
      },
      create: {
        appTargetId: target.id,
        version,
        // Android compares this, not the marketing string, and the sources
        // record it too — so a manual upload should not be the one hole.
        buildCode: manifest.versionCode,
        source: "MANUAL",
        arch,
        // Empty for an upload: there is no upstream, the artifact is the file
        // that was handed over. A link import keeps its URL and stays
        // re-cacheable after a prune.
        remoteUrl: input.remoteUrl?.trim() ?? "",
        filename,
        artifactPath: finalPath,
        sizeBytes: BigInt(size),
        sha256,
        status: "READY",
        cacheProgress: 100,
        approved: true,
        publishedAt: new Date(),
      },
    });

    bus.publish({ kind: "version", versionId: appVersion.id });
    log.info(
      { packageName, version, sizeBytes: size, wrapped, manualTarget: target.manual },
      "manual upload stored",
    );

    return {
      appVersionId: appVersion.id,
      appTargetId: target.id,
      packageName,
      version,
      filename,
      sizeBytes: size,
      sha256,
      wrapped,
      detected,
    };
  } catch (err) {
    await fs.rm(incoming, { force: true });
    await fs.rm(finalPath, { force: true });
    throw err;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
