"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { type HookMode, hub } from "@/lib/hub";

export type ManualInstallInput = {
  appVersionId: string;
  deviceIds: string[];
  preInstallHook: string | null;
  postInstallHook: string | null;
  hookMode: HookMode;
  writeConfig: boolean;
  /**
   * The MITM config these installs write, instead of each box's group one.
   *
   * Null is the normal case and means the group's. It exists because a deploy
   * often needs one value different for one set of boxes, and the alternative
   * was editing the group -- which changes every box in it, including the ones
   * the deploy is not touching.
   */
  mitmConfig: string | null;
  forceClean: boolean;
  /** Boxes reporting this exact version get a SKIPPED job instead of an install. */
  skipUpToDate: boolean;
  maxConcurrency: number | null;
  note: string | null;
};

export type ManualInstallResult = { rolloutId?: string; error?: string };

/**
 * Install an uploaded build on a chosen set of boxes.
 *
 * It is a normal rollout — same jobs, same retries, same page to watch it on.
 * What is different is where the artifact came from and that the hooks travel
 * with the rollout instead of coming off the device's group.
 */
export async function startManualInstall(input: ManualInstallInput): Promise<ManualInstallResult> {
  const user = await requireOperator();

  if (!input.appVersionId) return { error: "Upload or pick a build first." };
  if (input.deviceIds.length === 0) return { error: "Pick at least one device." };

  let rolloutId: string;
  try {
    const result = await hub.createRollout({
      appVersionId: input.appVersionId,
      deviceIds: input.deviceIds,
      forceClean: input.forceClean,
      // Always sent, never omitted: `createRollout` defaults it to true, so
      // leaving it out would turn the form's "off" into skipping.
      skipUpToDate: input.skipUpToDate,
      preInstallHook: input.preInstallHook,
      postInstallHook: input.postInstallHook,
      hookMode: input.hookMode,
      writeConfig: input.writeConfig,
      mitmConfig: input.mitmConfig,
      maxConcurrency: input.maxConcurrency,
      createdById: user.id,
      note: input.note,
    });
    rolloutId = result.id;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "rollout.manual",
      targetType: "Rollout",
      targetId: rolloutId,
      meta: { appVersionId: input.appVersionId, devices: input.deviceIds.length },
    },
  });

  revalidatePath("/");
  revalidatePath("/rollouts");
  revalidatePath("/manual");
  return { rolloutId };
}

export type CheckBuildUrlResult = {
  error?: string;
  probe?: {
    url: string;
    sizeBytes: number | null;
    contentType: string | null;
    filename: string;
  };
};

/**
 * Ask the hub what is at the end of a link, without fetching the whole thing.
 *
 * Answers what a HEAD can answer — that it is there, how big it is, what it is
 * called. Not the version: that is in the manifest at the end of a zip nobody
 * has downloaded yet, and it is read on import, exactly as an upload's is.
 */
export async function checkBuildUrl(url: string): Promise<CheckBuildUrlResult> {
  await requireOperator();

  const trimmed = url.trim();
  if (!trimmed) return { error: "Paste a link first." };

  try {
    const probe = await hub.probeBuildUrl(trimmed);
    if (probe.status >= 400) {
      return { error: `That link answered HTTP ${probe.status}.` };
    }
    return {
      probe: {
        url: probe.url,
        sizeBytes: probe.sizeBytes,
        contentType: probe.contentType,
        filename: probe.filename,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export type ImportBuildResult = {
  error?: string;
  build?: {
    appVersionId: string;
    packageName: string;
    version: string;
    sizeBytes: number;
    sha256: string;
  };
};

/**
 * Store a build from a link instead of an upload.
 *
 * The bytes never touch the browser or the proxy in front of the dashboard,
 * which is the whole point: a 250 MB bundle does not fit through a Cloudflare
 * body limit, and it does not have to. What is stored is identical either way.
 */
export async function importBuildFromUrl(input: {
  url: string;
  packageName?: string;
}): Promise<ImportBuildResult> {
  const user = await requireOperator();

  const url = input.url.trim();
  if (!url) return { error: "Paste a link first." };

  let build: Awaited<ReturnType<typeof hub.importBuildFromUrl>>;
  try {
    build = await hub.importBuildFromUrl({
      url,
      packageName: input.packageName?.trim() || undefined,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "version.import",
      targetType: "AppVersion",
      targetId: build.appVersionId,
      meta: { url, packageName: build.packageName, version: build.version },
    },
  });

  revalidatePath("/manual");
  return {
    build: {
      appVersionId: build.appVersionId,
      packageName: build.packageName,
      version: build.version,
      sizeBytes: build.sizeBytes,
      sha256: build.sha256,
    },
  };
}

/**
 * Forget an uploaded build. The artifact stays on disk — `Free old bundles` on
 * the Versions page is what reclaims space — but it stops being offered here.
 */
export async function deleteManualVersion(appVersionId: string): Promise<{ error?: string }> {
  await requireOperator();

  const version = await prisma.appVersion.findUnique({
    where: { id: appVersionId },
    include: { _count: { select: { rollouts: true } } },
  });
  if (!version) return { error: "That build no longer exists." };
  if (version.source !== "MANUAL") return { error: "Only uploaded builds can be removed here." };
  if (version._count.rollouts > 0) {
    return { error: "This build has rollouts pointing at it — cancel or keep them instead." };
  }

  await prisma.appVersion.delete({ where: { id: appVersionId } });
  revalidatePath("/manual");
  return {};
}
