import type { HostInfo } from "@magnemite/protocol";
import { prisma } from "@magnemite/db";
import { log } from "../log.js";

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
 * Stores one host report.
 *
 * Every field is optional and absent means "this agent did not say", never
 * zero — the same rule the device metrics follow, and the reason the Go side
 * sends pointers. `?? undefined` leaves whatever was last known in place,
 * because an agent that has not learned to report docker's version must not
 * wipe the version a newer one found.
 */
export async function applyHostReport(deviceId: string, host: HostInfo): Promise<void> {
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
  if (host.containers.length === 0) return;

  const bySerial = new Map(
    host.containers.filter((c) => c.serial).map((c) => [c.serial as string, c]),
  );
  if (bySerial.size === 0) return;

  const rows = await prisma.redroidInstance.findMany({
    where: { hostId: deviceId, serial: { in: [...bySerial.keys()] } },
    select: { id: true, serial: true },
  });

  const now = new Date();
  for (const row of rows) {
    const container = bySerial.get(row.serial);
    if (!container) continue;
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
}
