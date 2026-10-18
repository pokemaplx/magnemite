import { randomUUID } from "node:crypto";
import { CAPABILITY_PUSH_CONFIG, hasCapability } from "@magnemite/protocol";
import { prisma } from "@magnemite/db";
import { log } from "../log.js";
import { getConnection, sendTo } from "../registry.js";
import { agentUpdateInFlight } from "./agentRelease.js";
import { deviceForConfigSelect, renderConfig } from "./deviceConfig.js";
import { ACTIVE_STATES } from "./jobs.js";

/**
 * A MITM's config, rewritten on one box without installing anything.
 *
 * The install path stays the way a config reaches a fleet. This is for the one
 * box somebody is looking at: a config that never arrived, or one to try before
 * putting it in the group. The box stops the MITM with the group's pre-install
 * hook, writes the file exactly as an install would, and starts it again with
 * the post-install hook -- the restart being what the first `write_config`
 * lacked, since a running scanner does not re-read a file it has already read.
 *
 * Never logs the content, on either side. It holds the MITM's credentials, and
 * keeping them out of the audit log, the hub's log and the box's agent.log is
 * why this is not a command typed into Execute.
 */

/** What the dashboard shows before anything is written. */
export type ConfigPreview =
  | {
      /** The box's group declares no config to write. */
      state: "none";
    }
  | {
      state: "ready" | "refused";
      path: string;
      /**
       * Rendered for this box -- or, when the render refused, the template as
       * it stands, for somebody to fix the placeholder by hand.
       */
      content: string;
      /** Why it would not render, as the job log would have said it. */
      reason: string | null;
      /** What stops the MITM before the write, and what starts it after. */
      stop: string | null;
      start: string | null;
      /** False on an agent too old to know `push_config`. */
      capable: boolean;
    };

export type PushOutcome = {
  ok: boolean;
  path: string | null;
  sha256: string | null;
  error: string | null;
  hookError: string | null;
};

/** Two hooks of two minutes each on the box, plus the write and a margin. */
const PUSH_TIMEOUT_MS = (2 * 120 + 30) * 1000;

const waiting = new Map<string, (outcome: Omit<PushOutcome, "path">) => void>();

async function loadDevice(deviceId: string) {
  return prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      ...deviceForConfigSelect,
      kind: true,
      capabilities: true,
      group: {
        select: {
          ...deviceForConfigSelect.group.select,
          preInstallHook: true,
          postInstallHook: true,
        },
      },
    },
  });
}

/**
 * The commands either side of the write.
 *
 * The group's own install hooks, because they are already what stops and starts
 * this group's scanner around every install. A group with none gets the plain
 * version for its MITM: a force-stop, and its launcher activity.
 */
function hooksFor(group: {
  mitmPackageName: string | null;
  preInstallHook: string | null;
  postInstallHook: string | null;
}): { stop: string | null; start: string | null } {
  const pkg = group.mitmPackageName ? shellQuote(group.mitmPackageName) : null;
  return {
    stop: group.preInstallHook?.trim() || (pkg ? `am force-stop ${pkg}` : null),
    start:
      group.postInstallHook?.trim() ||
      (pkg ? `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1` : null),
  };
}

export async function previewConfig(deviceId: string): Promise<ConfigPreview> {
  const device = await loadDevice(deviceId);
  if (!device) throw new Error("device not found");

  const rendered = device.kind === "BOX" ? renderConfig(device) : null;
  if (!rendered || !device.group) return { state: "none" };

  const { stop, start } = hooksFor(device.group);
  const capable = hasCapability(device.capabilities, CAPABILITY_PUSH_CONFIG);
  const path = device.group.mitmConfigPath!;
  return rendered.ok
    ? { state: "ready", path, content: rendered.file.content, reason: null, stop, start, capable }
    : {
        state: "refused",
        path,
        content: device.group.mitmConfig ?? "",
        reason: rendered.reason,
        stop,
        start,
        capable,
      };
}

/**
 * Write the config to the box and restart its MITM.
 *
 * `content` is what the dashboard sends back after somebody edited it, and is
 * rendered again here, so a placeholder typed into it is still substituted.
 * Null writes the group's own template.
 */
export async function pushConfig(deviceId: string, content: string | null): Promise<PushOutcome> {
  const device = await loadDevice(deviceId);
  if (!device) throw new Error("device not found");
  if (!device.group?.mitmConfigPath) {
    throw new Error("this box's group has no config to write -- set one in its MITM data");
  }

  const rendered = renderConfig(device, content?.trim() ? content : null);
  if (!rendered) throw new Error("this box's group has no config to write");
  if (!rendered.ok) throw new Error(rendered.reason);

  if (!hasCapability(device.capabilities, CAPABILITY_PUSH_CONFIG)) {
    throw new Error(
      "this box's agent is too old to rewrite a config on its own; it updates itself to one that can",
    );
  }

  const conn = getConnection(deviceId);
  if (!conn || conn.readyAt === null) throw new Error("device is offline");
  if (conn.pushingConfig) throw new Error("this box's config is already being rewritten");
  if (agentUpdateInFlight(conn)) {
    throw new Error("this box is swapping its agent binary; try again in a minute");
  }
  // An install writes this same file between these same hooks.
  const busy =
    conn.currentJobId !== null ||
    (await prisma.job.count({ where: { deviceId, state: { in: ACTIVE_STATES } } })) > 0;
  if (busy) throw new Error("an install is running on this box; try again once it has finished");

  const { stop, start } = hooksFor(device.group);
  const requestId = randomUUID();
  const path = rendered.file.path;

  // On the connection rather than in a set here, so the scheduler and the
  // agent-update sweep can see it without importing this module: neither may
  // land an install or a binary swap between the stop and the start.
  conn.pushingConfig = true;
  try {
    const sent = sendTo(deviceId, {
      type: "push_config",
      requestId,
      config: rendered.file,
      preHook: stop,
      postHook: start,
    });
    if (!sent) throw new Error("device is offline");
    // The path and nothing else: the content is the credentials.
    log.info({ deviceId, path }, "config push sent");

    const outcome = await new Promise<Omit<PushOutcome, "path">>((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve({
          ok: false,
          sha256: null,
          error: "the box did not answer — it may have gone offline in the middle of it",
          hookError: null,
        });
      }, PUSH_TIMEOUT_MS);
      waiting.set(requestId, (answer) => {
        clearTimeout(timer);
        waiting.delete(requestId);
        resolve(answer);
      });
    });

    log.info(
      { deviceId, path, ok: outcome.ok, sha256: outcome.sha256, hookError: outcome.hookError },
      "config push answered",
    );
    return { ...outcome, path };
  } finally {
    conn.pushingConfig = false;
  }
}

/** Called from the socket handler when the box answers. */
export function resolveConfigPush(requestId: string, outcome: Omit<PushOutcome, "path">) {
  // Nobody waiting: the request timed out, or the hub restarted since.
  waiting.get(requestId)?.(outcome);
}

/** Single quotes, with any in the value closed, escaped and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
