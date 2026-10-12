import { REDROID_IMAGE } from "../version.js";

/**
 * Renders the compose file for one machine.
 *
 * Every property here is one the hand-written `deploy/redroid.compose.yml`
 * already sets, and each one is load-bearing — see that file's comments for the
 * long version. This renderer exists so adding a box is a number in a form
 * rather than a YAML block copied by hand.
 *
 * The output must be a **pure function of the instance rows**. The hub decides
 * whether a machine needs converging by comparing a fresh render against the
 * sha256 the machine read back off its own disk, so anything that varies
 * between two renders of the same desired state — a timestamp, a token that
 * disappears once a box has enrolled, a map iteration order — would make every
 * reconnect recreate every container. A changed `command:` list is exactly what
 * makes Docker recreate one.
 */

export type RenderInstance = {
  index: number;
  serial: string;
  /** Null inherits the machine's default, which inherits the settings group. */
  memLimitBytes: bigint | null;
  cpuset: string | null;
  image: string | null;
};

export type RenderHost = {
  project: string;
  /** The hub URL the boxes dial, which is never the dashboard's. */
  serverUrl: string;
  /**
   * The enrollment token new containers trade for one of their own.
   *
   * Rendered unconditionally, even for instances that have already enrolled,
   * and that is deliberate: dropping the line once a box has a device token
   * would change that service's `command:` and cost it a full Android cold
   * boot at an unpredictable later moment. The agent only reads it when its
   * config has no device token, so a stale one is inert — and the token is
   * revoked server-side when it is no longer wanted.
   */
  enrollToken: string;
  image: string;
  memLimitBytes: bigint;
  cpuset: string | null;
  gpuMode: string;
};

function serviceName(index: number): string {
  return `box-${String(index).padStart(2, "0")}`;
}

/** Bytes to the `4g` form compose takes. Whole units only, so the file stays readable. */
function memLimit(bytes: bigint): string {
  const gib = bytes / 1024n / 1024n / 1024n;
  if (gib > 0n && gib * 1024n * 1024n * 1024n === bytes) return `${gib}g`;
  const mib = bytes / 1024n / 1024n;
  if (mib > 0n) return `${mib}m`;
  return `${bytes}`;
}

/**
 * The file, as bytes.
 *
 * No YAML library: the shape is fixed and narrow, and a serialiser would
 * reformat it into something an operator could not diff against the
 * hand-written example. Everything interpolated is either a number the hub
 * generated or a string it validated, and `assertRenderable` below is what
 * keeps that true.
 */
export function renderCompose(host: RenderHost, instances: RenderInstance[]): string {
  assertRenderable(host, instances);

  // Sorted by index so two renders of the same desired state are byte
  // identical. Row order out of the database is not guaranteed, and an
  // unsorted render would change the file's hash — and recreate every
  // container — for nothing.
  const ordered = [...instances].sort((a, b) => a.index - b.index);

  const lines: string[] = [
    `name: ${host.project}`,
    "",
    "# Rendered by Magnemite from this machine's instance rows. Edits here are",
    "# overwritten on the next converge: change the instance count in the",
    "# dashboard instead. The hand-written deploy/redroid.compose.yml is the",
    "# example to copy when running containers without a managed host.",
    "",
    "services:",
  ];

  for (const instance of ordered) {
    const name = serviceName(instance.index);
    lines.push(
      `  ${name}:`,
      `    image: ${instance.image ?? host.image}`,
      // Redroid needs the host's binder devices; it does not run unprivileged.
      "    privileged: true",
      // on-failure, not unless-stopped: Docker would otherwise start every
      // container at once on a host reboot, and N Androids hitting peak memory
      // together is the OOM this whole design tries to avoid. The host agent
      // brings them back in waves instead.
      "    restart: on-failure",
      // The one property that decides whether a box reports its own RAM or the
      // machine's. The host reports back what docker actually applied, and the
      // hub flags a mismatch.
      `    mem_limit: ${memLimit(instance.memLimitBytes ?? host.memLimitBytes)}`,
    );

    const cpuset = instance.cpuset ?? host.cpuset;
    if (cpuset) lines.push(`    cpuset: "${cpuset}"`);

    lines.push(
      "    volumes:",
      // /data is the box's identity: config.json and its device token live
      // there. Losing the volume is harmless while the serial is stable,
      // because the hub then finds the existing row by serial.
      `      - ${name}-data:/data`,
      "    command:",
      // The namespaced property, which magnemite-start.sh reads. Not
      // ro.serialno: this one cannot collide with whatever the base image sets.
      `      - ro.magnemite.serial=${instance.serial}`,
      `      - androidboot.redroid_gpu_mode=${host.gpuMode}`,
      // What replaced ashmem, which is why the bootstrap does not install it.
      "      - androidboot.use_memfd=true",
      `      - ro.magnemite.server=${host.serverUrl}`,
      `      - ro.magnemite.enroll_token=${host.enrollToken}`,
      // A container has no kernel of its own and the kernel refuses reboot(2)
      // without CAP_SYS_BOOT. Restarting the framework is the equivalent that
      // works from inside, and it is what a REBOOT rule actually wants.
      "      - ro.magnemite.reboot_cmd=stop && start",
    );
  }

  if (ordered.length === 0) {
    // Compose rejects an empty `services:` mapping, and a drained machine is a
    // legitimate desired state. The key is dropped entirely and the orphan
    // pass is what removes the containers.
    lines.splice(lines.indexOf("services:"), 1);
  } else {
    lines.push("", "volumes:");
    for (const instance of ordered) lines.push(`  ${serviceName(instance.index)}-data:`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Refuses anything that would be written into the file unquoted.
 *
 * Not defence against an attacker — every value here comes from the hub's own
 * database — but against a value that would produce a file compose then
 * misreads, which on this path means a machine whose containers all fail to
 * come up with a YAML error nobody connects to the group they renamed.
 */
function assertRenderable(host: RenderHost, instances: RenderInstance[]): void {
  const plain = /^[A-Za-z0-9._:/@=+-]+$/;

  if (!plain.test(host.project)) {
    throw new Error(
      `compose project ${JSON.stringify(host.project)} has characters YAML would eat`,
    );
  }
  if (!plain.test(host.serverUrl)) {
    throw new Error("the hub URL has characters YAML would eat");
  }
  if (!plain.test(host.enrollToken)) {
    throw new Error("the enrollment token has characters YAML would eat");
  }
  for (const instance of instances) {
    if (!plain.test(instance.serial)) {
      throw new Error(`serial ${JSON.stringify(instance.serial)} has characters YAML would eat`);
    }
    if (!Number.isInteger(instance.index) || instance.index < 1) {
      throw new Error(`instance index ${instance.index} is not a positive integer`);
    }
  }

  const seen = new Set<number>();
  for (const instance of instances) {
    if (seen.has(instance.index)) {
      // Two services of the same name is a file compose reads as one, and the
      // second box would silently never exist.
      throw new Error(`two instances share index ${instance.index}`);
    }
    seen.add(instance.index);
  }
}

export { serviceName as composeServiceName };

/** Re-exported so callers take the tag from one place. */
export { REDROID_IMAGE as redroidImage };
