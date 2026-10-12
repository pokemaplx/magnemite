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

/**
 * Provision a machine, from the moment its provider handed over SSH access.
 *
 * The one action that is the whole point of the feature: a machine goes from an
 * address and a password to running containers without anything else being
 * typed. It returns as soon as the run starts, because the SSH half is minutes
 * — apt, Docker, kernel modules, possibly a reboot — and the row it creates is
 * what the page renders.
 *
 * The credential is passed straight through and kept nowhere. It is not in the
 * row, not in the log, and not in the audit entry below — which records the
 * machine, its address and who asked, because that is what an audit trail is
 * for and a password is not.
 */
export async function bootstrapHost(input: {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  desiredInstances: number;
  desiredWorkers: number | null;
}): Promise<ActionState & { id?: string }> {
  const user = await requireOperator();

  const name = input.name.trim();
  if (!name) return { error: "Give the machine a name." };
  if (!input.host.trim()) return { error: "Where should it connect?" };
  if (!input.username.trim()) return { error: "Which user should it log in as?" };
  if (!input.password && !input.privateKey) {
    return { error: "A password or a private key is needed to reach the machine." };
  }
  if (input.desiredInstances < 0 || input.desiredInstances > 64) {
    return { error: "Instances must be between 0 and 64." };
  }

  // Refused here rather than discovered at the end of a twenty-minute run: the
  // hub keys a machine on its name, and two machines sharing one would be one
  // machine as far as the fleet is concerned.
  const clash = await prisma.device.findFirst({
    where: { kind: "HOST", name },
    select: { id: true },
  });
  if (clash) return { error: `There is already a machine called ${name}.` };

  try {
    const { id } = await hub.bootstrapHost({ ...input, name });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.bootstrap",
        targetType: "RedroidBootstrap",
        targetId: id,
        meta: {
          name,
          // The address, which identifies the machine. Never the credential.
          address: `${input.username}@${input.host}`,
          desiredInstances: input.desiredInstances,
        },
      },
    });
    revalidatePath("/hosts");
    return { ok: true, id };
  } catch (err) {
    return {
      error: err instanceof HubError ? err.message : "Could not start provisioning that machine.",
    };
  }
}

/**
 * How long a run may say RUNNING before nothing can still be working on it.
 *
 * The hub's own SSH timeout, which is what makes this a fact rather than a
 * guess: a live run gives up by itself after it, so a row older than this is
 * either finished or orphaned — and orphaned is what a hub restart mid-run
 * leaves behind, because the run lives in a closure that goes with the process.
 */
const RUN_ABANDONED_AFTER_MS = 20 * 60 * 1000;

/**
 * Takes a finished or abandoned provisioning off the page.
 *
 * The Machines page lists every run that is not DONE, and nothing prunes them,
 * so a failure stays on screen until somebody says otherwise. That is right —
 * a provisioning that failed at four in the morning should still be there at
 * nine — but it needs a way to say otherwise, and until now the only one was
 * SQL.
 *
 * A run that is genuinely still going is refused rather than hidden: the row is
 * the only thing watching it, and dismissing it would leave an SSH session
 * working on a machine nobody is being told about.
 */
export async function dismissBootstrap(id: string): Promise<ActionState> {
  const user = await requireOperator();

  const row = await prisma.redroidBootstrap.findUnique({
    where: { id },
    select: {
      name: true,
      serial: true,
      state: true,
      startedAt: true,
      // Kept for the audit entry: once the row is deleted these numbers exist
      // nowhere else, and they are what the operator asked for.
      desiredInstances: true,
      desiredWorkers: true,
    },
  });
  // Already gone. Idempotent on purpose: two clicks, or two tabs, must not
  // turn into an error the second time — but the page that offered the button
  // is showing a row that is not there, so it has to be refreshed or Dismiss
  // looks like a button that does nothing.
  if (!row) {
    revalidatePath("/hosts");
    return { ok: true };
  }

  if (row.state === "RUNNING" && Date.now() - row.startedAt.getTime() < RUN_ABANDONED_AFTER_MS) {
    // Deliberately not "wait and it will resolve itself". That is only true of
    // a run whose hub is alive: the timeout lives in the same process as the
    // run, so a hub that was killed mid-run takes the clock with it and
    // nothing will ever move this row. Both ways out are named instead.
    // Refreshed even on the refusal: the row may have moved on since the page
    // was rendered, and an operator told "it is still running" should be
    // looking at what it is still running.
    revalidatePath("/hosts");
    return {
      error:
        "That provisioning started less than twenty minutes ago and may still be running. " +
        "A live run gives up on its own after twenty; one whose hub has already been restarted " +
        "is marked failed the next time the hub starts, and can be dismissed then.",
    };
  }

  try {
    await prisma.redroidBootstrap.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.dismissBootstrap",
        targetType: "RedroidBootstrap",
        targetId: id,
        // What was dismissed, since the row itself is gone: this entry is the
        // only remaining record that the attempt happened at all — including
        // what the machine was going to be brought up to, which the deleted
        // row was the only place holding.
        meta: {
          name: row.name,
          serial: row.serial,
          state: row.state,
          desiredInstances: row.desiredInstances,
          desiredWorkers: row.desiredWorkers,
        },
      },
    });
    revalidatePath("/hosts");
    return { ok: true };
  } catch {
    return { error: "Could not dismiss that provisioning." };
  }
}
