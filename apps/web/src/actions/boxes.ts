"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { hub, HubError, type BoxCandidate, type BoxScan } from "@/lib/hub";
import type { ActionState } from "@/actions/rollouts";

/**
 * Adding hardware boxes to the fleet over adb.
 *
 * The counterpart of `hosts.ts` for boxes, and the same division: reads go
 * straight to Prisma from the pages, and every write here has to reach adb —
 * which lives in the hub's image, or on a machine's socket — so all of them
 * go through the hub rather than writing rows and hoping.
 *
 * Nothing stored here is a credential. adb's own key is the credential and it
 * never leaves the hub; the enrollment tokens are minted per box inside the
 * run and exist in the database only as hashes.
 */

/** A run nobody is watching any more, for Dismiss to be allowed to clear. */
const RUN_ABANDONED_AFTER_MS = 45 * 60 * 1000;

/**
 * Sweep for boxes and return the scan's id.
 *
 * The dialog polls `boxScan` for the result. Nothing is written to any box
 * and nothing is written to the database: a probe reads.
 */
export async function scanForBoxes(input: {
  addresses: string;
  relayDeviceId: string | null;
}): Promise<ActionState & { id?: string; total?: number }> {
  const user = await requireOperator();

  const addresses = input.addresses.trim();
  if (!addresses) return { error: "Give it an address, a list, or a range like 192.168.1.0/24." };

  // Checked here rather than discovered as a timeout per address: a machine
  // that is offline cannot relay, and the hub would otherwise spend a minute
  // finding that out.
  if (input.relayDeviceId) {
    const relay = await prisma.device.findUnique({
      where: { id: input.relayDeviceId },
      select: { kind: true, status: true, name: true },
    });
    if (!relay || relay.kind !== "HOST") return { error: "That is not a machine." };
    if (relay.status !== "ONLINE") {
      return { error: `${relay.name} is offline — it has to be up to reach the boxes.` };
    }
  }

  try {
    const { id, total } = await hub.scanForBoxes({ addresses, relayDeviceId: input.relayDeviceId });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "box.scan",
        targetType: "BoxScan",
        targetId: id,
        // What was swept and from where. A scan touches nothing, but it is
        // still a scan of somebody's network and worth a trail.
        meta: { addresses, total, relayDeviceId: input.relayDeviceId },
      },
    });
    return { ok: true, id, total };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not start the scan." };
  }
}

/** Poll a scan. Separate from starting it because a sweep takes minutes. */
export async function boxScan(id: string): Promise<{ scan?: BoxScan; error?: string }> {
  await requireOperator();
  try {
    return { scan: await hub.getBoxScan(id) };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not read the scan." };
  }
}

/**
 * Put the agent on the boxes that were picked.
 *
 * The group is asked for here rather than left for afterwards, for the reason
 * the machine bootstrap gives: the box reboots, enrols on its own, and by the
 * time anybody could open its page it is already in `default` and already
 * carrying that group's MITM config.
 */
export async function enrollBoxes(input: {
  targets: BoxCandidate[];
  desiredGroupId: string | null;
  relayDeviceId: string | null;
  reboot: boolean;
  reprovision: boolean;
  names: Record<string, string>;
}): Promise<ActionState & { batchId?: string; rows?: number }> {
  const user = await requireOperator();

  if (input.targets.length === 0) return { error: "Pick at least one box." };
  if (input.targets.length > 64) return { error: "Sixty-four boxes at a time is the limit." };

  // Refused rather than attempted. Every one of these would fail on the box
  // and leave a row saying so, which is a worse way to learn that the scan
  // already knew.
  const blocked = input.targets.find((t) => !t.eligible && !input.reprovision);
  if (blocked) {
    return { error: `${blocked.address} cannot be enrolled: ${blocked.blockedBy}` };
  }

  // The last line of defence on the thing that silently breaks a fleet. The
  // hub decides this per box during the scan, but a dialog left open while
  // another operator enrolled the same box would submit a stale decision --
  // and two boxes sharing one serial is one Device row overwriting another.
  const expected = input.targets.map((t) => t.expectedSerial);
  if (expected.some((s) => !s)) {
    return { error: "That scan is stale — run it again before enrolling." };
  }
  if (new Set(expected).size !== expected.length) {
    return { error: "Two of those boxes would enrol under the same serial. Re-run the scan." };
  }

  try {
    const { batchId, rows } = await hub.enrollBoxes({
      targets: input.targets.map((t) => ({
        address: t.address,
        serial: t.serial,
        serialSource: t.serialSource,
        expectedSerial: t.expectedSerial,
        name: input.names[t.address]?.trim() || null,
      })),
      desiredGroupId: input.desiredGroupId,
      relayDeviceId: input.relayDeviceId,
      reboot: input.reboot,
      reprovision: input.reprovision,
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "box.enroll",
        targetType: "BoxEnroll",
        targetId: batchId,
        meta: {
          addresses: input.targets.map((t) => t.address),
          // Which serials the hub had to mint, which is the decision worth
          // being able to look up months later when a box's identity is in
          // question. Never a token.
          minted: input.targets.filter((t) => t.serialSource === "MINTED").map((t) => t.address),
          desiredGroupId: input.desiredGroupId,
          relayDeviceId: input.relayDeviceId,
          reprovision: input.reprovision,
        },
      },
    });
    revalidatePath("/");
    return { ok: true, batchId, rows };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not start enrolling." };
  }
}

/**
 * Clear a finished or abandoned enrollment off the fleet page.
 *
 * Idempotent, like dismissing a bootstrap: two clicks or two tabs must not
 * turn into an error the second time.
 */
export async function dismissBoxEnroll(id: string): Promise<ActionState> {
  const user = await requireOperator();

  const row = await prisma.boxEnroll.findUnique({
    where: { id },
    select: { address: true, serial: true, state: true, startedAt: true },
  });
  if (!row) {
    revalidatePath("/");
    return { ok: true };
  }

  // A run still going has a process behind it, and deleting its row would
  // leave that process writing progress to something that is gone. The
  // exception is a run old enough that its hub cannot still be working on it
  // -- the timeout lives in the same process, so a hub killed mid-run takes
  // the clock with it and nothing will ever move the row.
  if (row.state === "RUNNING" && Date.now() - row.startedAt.getTime() < RUN_ABANDONED_AFTER_MS) {
    return { error: "That one is still running. Give it a few minutes." };
  }

  await prisma.boxEnroll.delete({ where: { id } });
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "box.dismissEnroll",
      targetType: "BoxEnroll",
      targetId: id,
      meta: { address: row.address, serial: row.serial, state: row.state },
    },
  });
  revalidatePath("/");
  return { ok: true };
}

/** The `adb_keys` file to preseed into a golden image. */
export async function adbKeys(): Promise<{ keys?: string; error?: string }> {
  await requireOperator();
  try {
    return { keys: (await hub.adbKeys()).keys };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not read the adb keys." };
  }
}
