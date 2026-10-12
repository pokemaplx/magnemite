"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { hub, HubError } from "@/lib/hub";
import type { ActionState } from "@/actions/rollouts";

/**
 * Everything the Machines page does.
 *
 * Reads go straight to Prisma from the pages, as everywhere else. These are the
 * writes, and all of them have to reach a live socket — which is why each one
 * goes through the hub rather than writing rows here and hoping.
 */

function revalidateHost(id: string) {
  revalidatePath("/hosts");
  revalidatePath(`/hosts/${id}`);
  // A converge can change which boxes exist, so the fleet is stale too.
  revalidatePath("/");
}

/**
 * Set how many containers a machine runs.
 *
 * Zero is valid and is how a machine is drained, so it is deliberately not
 * refused. Capacity is advice rather than a limit: the form says what fits and
 * warns past it, and an operator who knows their own hardware better than the
 * coefficients do is allowed to say so.
 */
export async function scaleHost(
  hostId: string,
  count: number,
  workers: number | null,
): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();

  if (!Number.isInteger(count) || count < 0) return { error: "Instances must be 0 or more." };
  if (count > 64) return { error: "64 containers on one machine is past anything sensible." };
  if (workers !== null && (!Number.isInteger(workers) || workers < 1 || workers > 50)) {
    // 50 is where the scanners stop being happy, and on some licences it is
    // also the contractual ceiling. It is the whole reason a machine needs
    // several containers rather than one big one.
    return { error: "Workers must be between 1 and 50." };
  }

  try {
    const result = await hub.scaleHost(hostId, count, workers);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.scale",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { count, workers, added: result.added, removed: result.removed },
      },
    });
    revalidateHost(hostId);
    // The reason is carried through rather than swallowed: "nothing happened"
    // has several causes an operator needs told apart — offline, not adopted,
    // or already exactly right.
    return { ok: true, reason: result.sent ? undefined : result.reason };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not scale that machine." };
  }
}

/** Import the containers a machine already has, so a first converge is safe. */
export async function adoptHost(hostId: string): Promise<ActionState & { adopted?: number }> {
  const user = await requireOperator();
  try {
    const { adopted } = await hub.adoptHost(hostId);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.adopt",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { adopted },
      },
    });
    revalidateHost(hostId);
    return { ok: true, adopted };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not adopt that machine." };
  }
}

/** Re-send the compose file, even when its hash already matches. */
export async function convergeHost(hostId: string): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();
  try {
    const result = await hub.convergeHost(hostId, true);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.converge",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { sent: result.sent },
      },
    });
    revalidateHost(hostId);
    return { ok: true, reason: result.sent ? undefined : result.reason };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not converge that machine." };
  }
}

/**
 * Remove one container, or forget it entirely.
 *
 * The two are different operations and the difference is the whole point.
 * Remove destroys the container and keeps both the volume and the `Device` row,
 * so re-adding that index brings the same box back with its history, its name
 * and its group. Forget deletes the row, and the box's identity goes with it.
 *
 * Neither renumbers. Removing index 3 of ten leaves a gap the next scale-up
 * refills, because closing it would rewrite serials and a changed serial is a
 * new box with no history.
 */
export async function removeInstance(
  instanceId: string,
  forget: boolean,
): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();

  const instance = await prisma.redroidInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, hostId: true, index: true, deviceId: true },
  });
  if (!instance) return { error: "That instance is no longer there." };

  // A job mid-install on a box whose container is about to be destroyed would
  // sit in the queue until the stall timeout re-queued it to a box that no
  // longer exists. Cancelled first, so the rollout shows a cancellation rather
  // than a mystery.
  if (instance.deviceId) {
    const active = await prisma.job.findMany({
      where: {
        deviceId: instance.deviceId,
        state: {
          in: ["QUEUED", "DISPATCHED", "DOWNLOADING", "EXTRACTING", "INSTALLING", "VERIFYING"],
        },
      },
      select: { id: true },
    });
    for (const job of active) {
      await hub.cancelJob(job.id).catch(() => undefined);
    }
  }

  try {
    if (forget) {
      // The Device row goes too. Its serial was minted for this instance and
      // nothing else will ever present it, so leaving the row behind would
      // leave a box in the fleet table that can never come back.
      await prisma.redroidInstance.delete({ where: { id: instanceId } });
      if (instance.deviceId) {
        await prisma.device.delete({ where: { id: instance.deviceId } }).catch(() => undefined);
      }
    } else {
      await prisma.redroidInstance.update({
        where: { id: instanceId },
        data: { present: false },
      });
    }

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: forget ? "redroidInstance.forget" : "redroidInstance.remove",
        targetType: "RedroidInstance",
        targetId: instanceId,
        meta: { index: instance.index, hostId: instance.hostId },
      },
    });

    const result = await hub.convergeHost(instance.hostId);
    revalidateHost(instance.hostId);
    return { ok: true, reason: result.sent ? undefined : result.reason };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not remove that instance." };
  }
}

/** The site a machine's new containers enrol into. */
export async function setHostGroup(hostId: string, groupId: string | null): Promise<ActionState> {
  const user = await requireOperator();
  try {
    await prisma.redroidHost.update({
      where: { deviceId: hostId },
      data: { defaultGroupId: groupId },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.setGroup",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { groupId },
      },
    });
    revalidateHost(hostId);
    return { ok: true };
  } catch {
    return { error: "Could not set the group for that machine." };
  }
}
