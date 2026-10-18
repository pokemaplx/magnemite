import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { agentMessageSchema, type ServerMessage } from "@magnemite/protocol";
import { hashToken, prisma } from "@magnemite/db";
import { getHubSettings } from "../services/hubSettings.js";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { getConnection, isOnline, register, unregister } from "../registry.js";
import { maybeUpdateAgent, recordAgentUpdateFailure } from "../services/agentRelease.js";
import { resolveConfigPush } from "../services/configPush.js";
import { resolveExec } from "../services/deviceCommands.js";
import { dropStreams, failBundle, publishLogLines, rearmStreams } from "../services/deviceLogs.js";
import { failScreenshot } from "../services/deviceScreenshots.js";
import { markTerminatedByHub, openEpisode } from "../services/connectivity.js";
import { applyMetrics, markOffline, markOnline, trackedPackages } from "../services/devices.js";
import { ACTIVE_STATES, applyProgress, completeJob, logJobEvent } from "../services/jobs.js";
import { specForDevice } from "../services/monitor.js";
import { applyHostReport, convergeOnReconnect, recordConvergeResult } from "../services/redroid.js";
import { resolveBoxAdb } from "../services/boxEnroll.js";
import { recordBootstrapResult } from "../services/hostBootstrap.js";
import { nudge } from "../services/scheduler.js";

export const WS_PATH = "/ws/device";
/** Frame-level keepalive, independent of the protocol heartbeat. */
const PING_INTERVAL_MS = 30_000;

type SocketState = { deviceId: string; serial: string; alive: boolean };

const state = new WeakMap<WebSocket, SocketState>();

function clientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? null;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  // Fallback for WebSocket clients that cannot set headers on the handshake.
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

export function attachDeviceSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) return; // let other upgrade handlers have it

    void (async () => {
      const token = bearerToken(req);
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const device = await prisma.device.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, serial: true },
      });
      if (!device) {
        log.warn({ ip: clientIp(req) }, "websocket auth rejected");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        state.set(ws, { deviceId: device.id, serial: device.serial, alive: true });
        void onConnection(ws, req, device.id, device.serial);
      });
    })().catch((err) => {
      log.error({ err }, "upgrade failed");
      socket.destroy();
    });
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      const s = state.get(ws);
      if (!s) continue;
      if (!s.alive) {
        // Worth naming, because the close that follows is otherwise just a
        // 1006 like any other: this one is the hub's own decision, and the
        // episode should say so rather than guess at a lost link.
        log.warn({ deviceId: s.deviceId }, "terminating the socket: two keepalives unanswered");
        markTerminatedByHub(s.deviceId);
        ws.terminate();
        continue;
      }
      s.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, PING_INTERVAL_MS);

  wss.on("close", () => clearInterval(pinger));
  return wss;
}

async function onConnection(ws: WebSocket, req: IncomingMessage, deviceId: string, serial: string) {
  const ip = clientIp(req);
  const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));

  register({
    deviceId,
    serial,
    socket: ws,
    remoteIp: ip,
    agentVersion: null,
    abi: null,
    sessionId: null,
    agentStartedAt: null,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    currentJobId: null,
    // Set by the hello, once it has been applied. Until then the scheduler
    // leaves this socket alone.
    readyAt: null,
    pushingConfig: false,
    send,
  });

  // The listener goes on before any of the setup below, because the agent
  // sends `hello` the instant the socket opens — well inside the few
  // milliseconds the queries here take. A listener attached afterwards misses
  // that frame entirely, and with it the agent version, the device details and
  // the package inventory it carries.
  //
  // Frames must also be applied in the order they arrived: handling them
  // concurrently lets a job_progress that started earlier land after the
  // job_result and drag a finished job back to DOWNLOADING. So everything
  // queues, behind the setup itself.
  let releaseSetup: () => void = () => {};
  let queue: Promise<void> = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    queue = queue.then(() =>
      handleMessage(ws, deviceId, ip, text).catch((err) =>
        log.error({ err, deviceId }, "message handler failed"),
      ),
    );
  });

  // Up here with the message listener rather than after the setup below, for
  // the reason that listener is: `ws` is an EventEmitter, and an `error` with
  // nothing listening is thrown — it would take the hub down. The window was
  // the five queries below, which is exactly the window in which a box that
  // has just lost power errors.
  ws.on("error", (err) => log.warn({ err, deviceId }, "socket error"));

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    releaseSetup();
    // `register` already ran, and the close handler that would undo it is not
    // attached until the bottom of this function — so without this the entry
    // stayed in the registry forever, and `isOnline` lied about a box that no
    // longer exists. That matters a great deal now that the offline sweep and
    // AGENT_OFFLINE both trust it.
    unregister(deviceId, ws);
    ws.close(4004, "device deleted");
    return;
  }

  send({
    type: "welcome",
    deviceId,
    name: device.name,
    approved: device.approved,
    // Set from Settings → Tuning. A box adopts it here, on connect, and again
    // from the `welcome` the hub pushes when the value is saved — this is the
    // path for a box that was offline at the time.
    heartbeatSeconds: (await getHubSettings()).heartbeatSeconds,
    trackedPackages: await trackedPackages(),
    // What to watch, which depends on the box's group. Null for a fleet with
    // monitoring off, which is also what stops an agent probing after the last
    // rule is switched off.
    monitor: await specForDevice(device.groupId, device.kind),
  });

  await prisma.device.update({
    where: { id: deviceId },
    data: { status: "ONLINE", lastSeenAt: new Date(), publicIp: ip },
  });
  bus.publish({ kind: "device", deviceId });
  log.info({ deviceId, serial, ip }, "device connected");

  // Setup is done: anything that arrived meanwhile now runs, in order.
  releaseSetup();

  // A panel left open while the box was away is still waiting for lines.
  rearmStreams(deviceId);

  ws.on("pong", () => {
    const s = state.get(ws);
    if (s) s.alive = true;
  });

  ws.on("close", (code, reason) => {
    unregister(deviceId, ws);
    // `unregister` only drops the socket when it is the registered one, so
    // from here `isOnline` true means a *newer* socket is already live. Nothing
    // this corpse has to say is about the box any more — which is why the
    // follows were already guarded, and why `markOffline` writing OFFLINE over
    // the new socket's ONLINE was the bug sitting next to that guard.
    if (isOnline(deviceId)) {
      log.info({ deviceId, code }, "a replaced socket closed; the newer one is live");
      return;
    }
    dropStreams(deviceId);
    void markOffline(deviceId);
    void openEpisode(deviceId, { closeCode: code, closeReason: reason.toString() || null });
    log.info({ deviceId, code, reason: reason.toString() }, "device disconnected");
  });

  // No nudge here, though the box may have been offline while a rollout was
  // created for it: nothing is dispatched down this socket until its hello has
  // been applied, so the nudge that matters is the one at the end of the hello.
}

async function handleMessage(ws: WebSocket, deviceId: string, ip: string | null, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn({ deviceId }, "dropped non-JSON frame");
    return;
  }

  const result = agentMessageSchema.safeParse(parsed);
  if (!result.success) {
    log.warn({ deviceId, issues: result.error.issues }, "dropped malformed frame");
    return;
  }
  const msg = result.data;
  const s = state.get(ws);
  if (s) s.alive = true;

  switch (msg.type) {
    case "hello": {
      // Kept on the connection so the periodic sweep can update a box that was
      // busy — or over the batch limit — when it said hello.
      //
      // Set before anything that reads it back, which this used to be after.
      // `applyMetrics` below closes the connectivity episode this hello ends,
      // and that episode wants to name the session which ended it — so with
      // the assignment further down, every episode's `sessionAfter` came out
      // null, losing the one field that points into the box's own agent.log.
      const conn = getConnection(deviceId);
      if (conn) {
        conn.agentVersion = msg.agentVersion;
        conn.abi = msg.device.abi ?? null;
        conn.sessionId = msg.device.sessionId ?? null;
        conn.agentStartedAt = msg.device.agentStartedAt ?? null;
        conn.currentJobId = msg.currentJobId ?? null;
      }

      try {
        await markOnline(deviceId, {
          agentVersion: msg.agentVersion,
          publicIp: ip,
          info: msg.device,
          capabilities: msg.capabilities,
        });
        await applyMetrics(deviceId, msg.metrics);
        // Absent from every box. A machine's own readings went through
        // applyMetrics above, like any Device's; this is the half only a host
        // has -- what docker is, and what containers it is holding.
        if (msg.host) await applyHostReport(deviceId, msg.host);
        await reconcileJobs(deviceId, msg.currentJobId ?? null, (m) => ws.send(JSON.stringify(m)));
        // A box on an older binary than the hub ships gets told to update
        // itself. It re-execs and comes straight back with a new hello, which
        // is where the update is confirmed.
        //
        // Awaited, and before the box is marked ready below, so the update and
        // the first install cannot cross. A fresh container whose image
        // carries an older agent is told to update on this very hello; had a
        // job gone out alongside it, the re-exec would have killed the install
        // half way, and the hello after it would have re-queued the job as one
        // the box had never heard of. Decided first, an update in flight holds
        // the box's jobs (see the scheduler) and a box with none to do takes
        // its jobs now.
        await maybeUpdateAgent(
          {
            id: deviceId,
            abi: msg.device.abi ?? null,
            agentVersion: msg.agentVersion,
            currentJobId: msg.currentJobId ?? null,
            agentStartedAt: msg.device.agentStartedAt ?? null,
          },
          (m) => ws.send(JSON.stringify(m)),
        ).catch((err) => log.error({ err, deviceId }, "agent update check failed"));
      } finally {
        // Only now may the scheduler hand this socket a job: the row carries
        // what this agent can do, and the reconcile above ran against a list
        // that nothing on this socket could have added to. See `readyAt`.
        //
        // In a `finally` because the hello is never sent twice: a database
        // blip half way through it would otherwise leave the box taking no
        // jobs at all until it next reconnected, which can be days.
        //
        // Looked up again rather than taken from the top of this case: a box
        // that reconnected while this hello was being applied has a newer
        // socket whose own hello has not been, and marking *that* one ready
        // would reopen exactly the window this closes.
        const live = getConnection(deviceId);
        if (live && live.socket === ws) live.readyAt = Date.now();

        // The box may have been offline while a rollout was created for it,
        // and this is the first moment it can be handed one.
        nudge();

        // A machine is converged when it comes back, which is what a scale
        // made while it was away was promised. A no-op when its compose file
        // is already the one its rows describe.
        if (msg.host) {
          void convergeOnReconnect(deviceId).catch((err) =>
            log.error({ err, deviceId }, "reconnect converge failed"),
          );
        }
      }
      break;
    }

    case "host_converge_result":
      await recordConvergeResult(deviceId, msg);
      break;

    case "host_bootstrap_result":
      await recordBootstrapResult(deviceId, msg);
      break;

    // A machine reporting what adb found, or did, on the boxes around it.
    // Nothing is stored here: the run that asked is still open and holding
    // the rows, and this is only how the answer reaches it.
    case "box_adb_result":
      resolveBoxAdb(msg);
      break;

    case "heartbeat": {
      const conn = getConnection(deviceId);
      if (conn) conn.currentJobId = msg.currentJobId ?? null;
      await applyMetrics(deviceId, msg.metrics);
      if (msg.host) await applyHostReport(deviceId, msg.host);
      if (msg.currentJobId) {
        await prisma.job
          .updateMany({
            where: { id: msg.currentJobId, state: { in: ACTIVE_STATES } },
            data: { heartbeatAt: new Date() },
          })
          .catch(() => undefined);
      }
      break;
    }

    case "job_progress": {
      await assertJobBelongsTo(deviceId, msg.jobId, async () => {
        await applyProgress(msg.jobId, msg.state, msg.progress, msg.message ?? null);
      });
      break;
    }

    case "job_result": {
      // The box is free again, so its next job need not wait a heartbeat for
      // the agent to say so. Before the ownership check rather than inside it:
      // a result for a job the hub has since deleted still frees the box.
      const conn = getConnection(deviceId);
      if (conn && conn.socket === ws && conn.currentJobId === msg.jobId) {
        conn.currentJobId = null;
      }
      await assertJobBelongsTo(deviceId, msg.jobId, async () => {
        await completeJob(msg.jobId, {
          ok: msg.ok,
          installMode: msg.installMode ?? null,
          dataWiped: msg.dataWiped,
          installedVersion: msg.installedVersion ?? null,
          error: msg.error ?? null,
        });
        nudge();
      });
      break;
    }

    case "log": {
      if (msg.jobId) {
        await assertJobBelongsTo(deviceId, msg.jobId, async () => {
          await logJobEvent(msg.jobId!, msg.message, { level: msg.level });
        });
      } else {
        log.debug({ deviceId, level: msg.level }, msg.message);
      }
      break;
    }

    case "exec_result": {
      resolveExec(msg.commandId, {
        ok: msg.ok,
        output: msg.output,
        error: msg.error ?? null,
      });
      break;
    }

    case "push_config_result": {
      resolveConfigPush(msg.requestId, {
        ok: msg.ok,
        sha256: msg.sha256 ?? null,
        error: msg.error ?? null,
        hookError: msg.hookError ?? null,
      });
      break;
    }

    case "log_lines": {
      publishLogLines(deviceId, msg.streamId, { lines: msg.lines, dropped: msg.dropped });
      break;
    }

    case "log_bundle_result": {
      // Only failures arrive here — a bundle that worked announces itself by
      // being uploaded.
      if (!msg.ok) {
        await failBundle(msg.bundleId, msg.error ?? "the agent could not collect the logs");
      }
      break;
    }

    case "screenshot_result": {
      // Same as the bundle above: only failures arrive here, because a capture
      // that worked announces itself by landing on the upload route.
      if (!msg.ok) {
        await failScreenshot(msg.screenshotId, msg.error ?? "the box could not take a screenshot");
      }
      break;
    }

    case "agent_update_result": {
      // Only failures are reported. A successful swap is confirmed by the
      // hello the new binary sends, not by a frame from the old one.
      if (!msg.ok) {
        await recordAgentUpdateFailure(deviceId, msg.version, msg.error ?? null);
        // Its jobs were held for an update that is not coming, so they go
        // now rather than on the next tick.
        nudge();
      }
      break;
    }

    case "pong":
      break;
  }
}

/** A device may only touch its own jobs. */
async function assertJobBelongsTo(deviceId: string, jobId: string, fn: () => Promise<void>) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { deviceId: true } });
  if (!job) return;
  if (job.deviceId !== deviceId) {
    log.warn({ deviceId, jobId }, "device reported on a job that is not its own");
    return;
  }
  await fn();
}

/**
 * Line up what the agent thinks it is doing with what the database thinks.
 * The two drift whenever one side restarts: a hub restart loses nothing, but
 * a box that reboots mid-install comes back with no job while the row still
 * says INSTALLING.
 *
 * Every active job this finds was dispatched down an *earlier* socket, which
 * is what makes "the agent has not heard of it" true. That holds because the
 * scheduler sends nothing down a socket before its hello is applied -- when it
 * could, this re-queued the job it had just sent, read against a hello the box
 * wrote before that job reached it, and the box got the same job twice.
 */
async function reconcileJobs(
  deviceId: string,
  agentJobId: string | null,
  send: (msg: ServerMessage) => void,
) {
  const active = await prisma.job.findMany({
    where: { deviceId, state: { in: ACTIVE_STATES } },
  });

  for (const job of active) {
    if (job.id === agentJobId) continue;
    // We think it is running, the agent has never heard of it (or moved on).
    await prisma.job.update({
      where: { id: job.id },
      // Not a failed attempt, so no backoff: the box is here and idle, and the
      // job it should be running is the one we are putting back.
      data: {
        state: "QUEUED",
        progress: 0,
        nextAttemptAt: null,
        dispatchedAt: null,
        heartbeatAt: null,
      },
    });
    await logJobEvent(job.id, "agent reconnected without this job, re-queued", { level: "WARN" });
    bus.publish({ kind: "job", jobId: job.id, rolloutId: job.rolloutId, deviceId });
  }

  if (agentJobId && !active.some((j) => j.id === agentJobId)) {
    // The agent is working on something we consider finished or cancelled.
    send({ type: "cancel_job", jobId: agentJobId });
  }
}
