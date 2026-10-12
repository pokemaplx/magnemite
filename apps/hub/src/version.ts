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
 * One place, because two halves depend on it: the bootstrap builds this tag on
 * a new machine and the compose file names it. If they drifted, a freshly
 * provisioned machine would build one image and be asked to run another -- and
 * fail on a pull that cannot succeed, since the tag is local and there is no
 * registry behind it.
 */
export const REDROID_IMAGE = `magnemite/redroid:${VERSIONS.redroid ?? "1"}`;
