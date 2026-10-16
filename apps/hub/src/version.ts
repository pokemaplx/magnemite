import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which release each piece of this deployment is.
 *
 * The repo's VERSION file holds one `key=value` line per deployable, and the
 * image is built with it copied in beside the app — so a running container can
 * say what it is rather than leaving someone to match a deploy timestamp
 * against a commit. Outside a container (`pnpm dev`, a test) the file is a few
 * directories up; when it is nowhere at all, this is a dev build.
 */
const CANDIDATES = [
  "/app/VERSION",
  path.resolve(process.cwd(), "VERSION"),
  path.resolve(process.cwd(), "../../VERSION"),
];

export function parseVersions(contents: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    versions[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return versions;
}

function read(): Record<string, string> {
  for (const candidate of CANDIDATES) {
    try {
      const versions = parseVersions(readFileSync(candidate, "utf8"));
      if (Object.keys(versions).length > 0) return versions;
    } catch {
      // Next candidate.
    }
  }
  return {};
}

/** Read once: it cannot change without the process being replaced. */
const VERSIONS = read();

/** This process's own version. */
export const HUB_VERSION = VERSIONS.hub ?? "dev";

/**
 * The Redroid image tag, from the same file.
 *
 * Versioned by what is *in* that image -- the base, the start script, the init
 * service -- and deliberately not by the agent, whose binary inside is only a
 * seed each box's own self-update replaces. A tag that moved with every agent
 * release would change the rendered compose file and have Docker recreate every
 * container on the machine for nothing.
 *
 * One place, because two halves depend on it: the bootstrap puts this tag on a
 * new machine and the compose file names it. If they drifted, a freshly
 * provisioned machine would have one image and be asked to run another.
 *
 * Still a **local** tag, now that CI publishes the image: see the source below
 * for why that is deliberate.
 */
export const REDROID_IMAGE = `magnemite/redroid:${VERSIONS.redroid ?? "1"}`;

/**
 * Where a machine gets that image when it does not already have it.
 *
 * CI builds this on an arm64 runner and publishes it per `redroid=`, so
 * provisioning pulls it instead of spending a 780 MB build on every new
 * machine -- the step that used to be the slowest part of a bootstrap, and the
 * one most likely to fail on a machine nobody is watching.
 *
 * The bootstrap pulls this and retags it as REDROID_IMAGE above rather than
 * naming it in the compose file, which looks redundant and is not: the
 * rendered `image:` line is compared by docker as a string, so moving it to a
 * registry reference would recreate every container on every machine already
 * running -- a cold boot of every Android on it -- to deliver a byte-identical
 * image. The local tag is what the fleet runs; this is only where it comes
 * from.
 */
export const REDROID_IMAGE_SOURCE = `ghcr.io/pokemaplx/magnemite/redroid:${VERSIONS.redroid ?? "1"}`;
