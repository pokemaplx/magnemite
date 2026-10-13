import { prisma } from "@magnemite/db";
import { log } from "../log.js";
import { TERMINAL_STATES } from "./jobs.js";
import { createRollout } from "./rollouts.js";

/**
 * Gives a box what its group says every new box needs.
 *
 * The gap this closes is the first minute of a box's life. A container that
 * has just come up, or a box somebody has just flashed, is in its group with
 * nothing installed -- and everything else the fleet does assumes the scanner
 * and its MITM are already there. So the first thing after every scale-up was
 * a trip to Manual deploy to install the same two builds on the same kind of
 * box again.
 *
 * Nothing happens unless somebody filled the group's join set, which is empty
 * everywhere by default. This creates rollouts with no operator in the loop,
 * and that is the one shape of feature worth being this careful about.
 */
export async function queueJoinInstalls(deviceId: string): Promise<number> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      kind: true,
      approved: true,
      groupId: true,
      // What it already has. The agent reports only the packages the hub
      // tracks, which is exactly the set a join install can name.
      packages: {
        where: { installed: true },
        select: { packageName: true, versionName: true },
      },
    },
  });

  // A host installs no APKs and has no `pm` to install them with, and an
  // unapproved box is refused by createRollout anyway -- it would build a
  // rollout targeting nothing and report success.
  if (!device || device.kind !== "BOX" || !device.approved || !device.groupId) return 0;

  const wanted = await prisma.groupJoinInstall.findMany({
    where: { groupId: device.groupId },
    select: {
      appVersion: {
        select: {
          id: true,
          version: true,
          status: true,
          appTarget: { select: { packageName: true } },
        },
      },
    },
  });
  if (wanted.length === 0) return 0;

  const have = new Map(device.packages.map((p) => [p.packageName, p.versionName]));

  let queued = 0;
  for (const { appVersion } of wanted) {
    // Decided here rather than left to the rollout's own skipUpToDate.
    //
    // Both would end in the right place, but this is what stops a box that
    // reconnects from leaving a trail of rollouts whose every job is SKIPPED.
    // A box enrols rarely and a wiped one enrols again, so the question is
    // genuinely "does it have this build" and not "has it enrolled before".
    if (have.get(appVersion.appTarget.packageName) === appVersion.version) continue;

    // A build a feed listed and never cached cannot be installed, and
    // createRollout throws rather than returning. Skipped with a line in the
    // log, because the alternative is one bad entry in a group's set silently
    // costing every other build in it.
    if (appVersion.status !== "READY") {
      log.warn(
        { deviceId, appVersionId: appVersion.id, status: appVersion.status },
        "join install skipped: that build is not cached",
      );
      continue;
    }

    // A box that has just enrolled reports no packages yet -- it sends them
    // over the socket afterwards -- so the check above cannot see an install
    // that is already on its way. Without this, an agent restarting twice
    // before it reports would get a second rollout for the same build.
    //
    // Anything not finished, which is `notIn TERMINAL_STATES` and **not**
    // `in ACTIVE_STATES`. That distinction cost a test: this module's
    // ACTIVE_STATES is only what the agent moves through while working, so it
    // leaves out QUEUED -- the one state a job just created is always in, and
    // therefore the only one this check had to catch.
    //
    // A finished job is deliberately not a reason to refuse. A box whose /data
    // was wiped comes back as the same row with an empty filesystem and a
    // SUCCESS in its history, and that is exactly when it needs the install
    // again; what stops a loop there is the package check above, once the box
    // has reported what it has.
    const alreadyGoing = await prisma.job.findFirst({
      where: {
        deviceId: device.id,
        state: { notIn: TERMINAL_STATES },
        rollout: { appVersionId: appVersion.id },
      },
      select: { id: true },
    });
    if (alreadyGoing) continue;

    try {
      await createRollout({
        appVersionId: appVersion.id,
        deviceIds: [device.id],
        // Still true, as a second line of defence: between the read above and
        // this call the box may have reported the very build being installed.
        skipUpToDate: true,
        // Nobody pressed anything, so there is no user to attribute it to --
        // and the note is what makes the rollout list legible later, where an
        // unexplained one-box rollout is otherwise a small mystery.
        createdById: null,
        note: `joined its group`,
      });
      queued += 1;
    } catch (err) {
      // One build failing must not stop the others: the MITM going in without
      // the scanner is still a box closer to working than neither.
      log.warn({ err, deviceId, appVersionId: appVersion.id }, "could not queue a join install");
    }
  }

  if (queued > 0) {
    log.info({ deviceId, queued, groupId: device.groupId }, "queued join installs");
  }
  return queued;
}
