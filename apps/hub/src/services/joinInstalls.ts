import { prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { getHubSettings } from "./hubSettings.js";
import { logJobEvent, rolloutSucceeded, TERMINAL_STATES } from "./jobs.js";
import { inMaintenance } from "./maintenance.js";
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
 *
 * `bootedAround` is when the box came up, for a caller that knows better than
 * the row does. Enrolment does: the row's `bootedAt` is the previous life's on
 * a box that was re-flashed, and absent on one that has never said hello.
 */
export async function queueJoinInstalls(
  deviceId: string,
  opts: { bootedAround?: Date } = {},
): Promise<number> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      kind: true,
      approved: true,
      groupId: true,
      maintenanceUntil: true,
      bootedAt: true,
      group: { select: { mitmPackageName: true } },
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

  // A parked box is one somebody is holding, and this is the one path that
  // installs with nobody watching -- so it waits. Checked here rather than
  // left to `createRollout`, which would throw and leave a warning in the log
  // that reads like a fault: a box that will get its builds when its window
  // closes is not a box anything went wrong on.
  //
  // Nothing re-runs this at expiry, and that is correct: the next enrolment,
  // approval or group change calls it, and in the meantime the group's set is
  // still what it was. A box parked through its own first minute gets its
  // builds the next time it reconnects.
  if (inMaintenance(device)) {
    log.info({ deviceId }, "join installs held: this box is in maintenance");
    return 0;
  }

  const rows = await prisma.groupJoinInstall.findMany({
    where: { groupId: device.groupId },
    select: {
      appVersion: {
        select: {
          id: true,
          version: true,
          status: true,
          appTarget: { select: { packageName: true, displayName: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return 0;

  // These go in a chosen order rather than whichever row came back first: the
  // order they were added, with the group's MITM moved to the end -- and each
  // after the first waits for the one before it to succeed (`waitsForId`), so
  // the order is a chain rather than a race the scheduler happens to win.
  //
  // The MITM last because its install is the one that writes its config and
  // runs the post-install hook that starts it, and both want the game already
  // on the box. Installed first, it was started against a game that was not
  // there, and only the game's own install, minutes later, put that right.
  const mitm = device.group?.mitmPackageName ?? null;
  const wanted = [
    ...rows.filter((row) => row.appVersion.appTarget.packageName !== mitm),
    ...rows.filter((row) => row.appVersion.appTarget.packageName === mitm),
  ];

  // How long the box still has to settle, if at all. From its boot rather
  // than from now: a box approved an hour after it came up has long since
  // settled and waits for nothing, while one approved the minute it enrolled
  // waits out the rest.
  const { joinInstallDelaySeconds } = await getHubSettings();
  const bootedAround = opts.bootedAround ?? device.bootedAt ?? new Date();
  const settledAt = new Date(bootedAround.getTime() + joinInstallDelaySeconds * 1000);
  const notBefore = settledAt.getTime() > Date.now() ? settledAt : null;

  const have = new Map(device.packages.map((p) => [p.packageName, p.versionName]));

  // The rollout the next one waits for, and what to call it in the job log.
  let previous: { id: string; label: string } | null = null;
  let queued = 0;
  for (const { appVersion } of wanted) {
    const isMitm = appVersion.appTarget.packageName === mitm;
    const label = `${appVersion.appTarget.displayName} ${appVersion.version}`;

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
      select: { rolloutId: true, rollout: { select: { status: true, waitsForId: true } } },
    });
    if (alreadyGoing) {
      // Still on its way from an earlier call, so what comes after waits for
      // it. And if it is itself waiting, it waits for what this call has
      // lined up ahead of it: an approval after a failed game queues the game
      // again, and a MITM left waiting on the failed attempt would wait for
      // good.
      const ahead = previous?.id ?? null;
      if (alreadyGoing.rollout.status === "PENDING" && alreadyGoing.rollout.waitsForId !== ahead) {
        await rewait(alreadyGoing.rolloutId, ahead);
      }
      previous = { id: alreadyGoing.rolloutId, label };
      continue;
    }

    try {
      const rollout = await createRollout({
        appVersionId: appVersion.id,
        deviceIds: [device.id],
        // Still true, as a second line of defence: between the read above and
        // this call the box may have reported the very build being installed.
        skipUpToDate: true,
        // No hooks on the way to a working box, bar the one that starts it.
        // The pre-install hook stops a scanner that is not running yet, and a
        // post-install hook after the game would start a MITM that is not on
        // the box yet: only the MITM's own install runs one, last, once the
        // game is there for it.
        hookMode: isMitm ? "POST_ONLY" : "NONE",
        waitsForId: previous?.id ?? null,
        // Nobody pressed anything, so there is no user to attribute it to --
        // and the note is what makes the rollout list legible later, where an
        // unexplained one-box rollout is otherwise a small mystery.
        createdById: null,
        note: `joined its group`,
        notBefore,
      });
      // Said on the job, because a join install that sits queued on a box
      // that is online otherwise reads as a scheduler that forgot it.
      const job = rollout.jobs[0];
      if (job?.state === "QUEUED" && rollout.status === "PENDING" && previous) {
        await logJobEvent(job.id, `waiting for ${previous.label} to install first`, {
          phase: "QUEUED",
        });
      } else if (job?.state === "QUEUED" && notBefore) {
        const seconds = Math.ceil((notBefore.getTime() - Date.now()) / 1000);
        await logJobEvent(job.id, `held ${seconds}s while the box settles after booting`, {
          phase: "QUEUED",
        });
      }
      previous = { id: rollout.id, label };
      queued += 1;
    } catch (err) {
      // One build that cannot be queued does not stop the rest: what follows
      // waits for the last one that could be, and the line here says why
      // this one is missing.
      log.warn({ err, deviceId, appVersionId: appVersion.id }, "could not queue a join install");
    }
  }

  if (queued > 0) {
    log.info({ deviceId, queued, groupId: device.groupId, notBefore }, "queued join installs");
  }
  return queued;
}

/**
 * Point a waiting rollout at a different prerequisite -- or start it, when
 * there is nothing left to wait for or what it would wait for has already
 * succeeded.
 */
async function rewait(rolloutId: string, waitsForId: string | null) {
  const prerequisite = waitsForId
    ? await prisma.rollout.findUnique({
        where: { id: waitsForId },
        select: { status: true, jobs: { select: { state: true } } },
      })
    : null;
  const release = !prerequisite || rolloutSucceeded(prerequisite);
  await prisma.rollout.update({
    where: { id: rolloutId },
    data: release ? { waitsForId, status: "RUNNING", startedAt: new Date() } : { waitsForId },
  });
  bus.publish({ kind: "rollout", rolloutId });
}
