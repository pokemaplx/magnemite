import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, serialize } from "@magnemite/db";
import {
  getHubSettings,
  invalidateHubSettingsCache,
  peekHeartbeatSeconds,
} from "../services/hubSettings.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { connectionCount, onlineDeviceIds, sendTo } from "../registry.js";
import { cacheVersion, pruneArtifacts } from "../services/artifacts.js";
import { execOnDevice } from "../services/deviceCommands.js";
import { broadcastWelcome } from "../services/devices.js";
import { normaliseLogPath, requestBundle, subscribeToLogs } from "../services/deviceLogs.js";
import { collectHealth } from "../services/health.js";
import { cancelJob, retryFailedJobs, retryJob } from "../services/jobs.js";
import { evaluate } from "../services/monitor.js";
import { sendTestAlert } from "../services/notify.js";
import { cancelRollout, createRollout, resumeRollout } from "../services/rollouts.js";
import {
  type RotomAction,
  cachedWorkers,
  deviceAction,
  rotomEnabled,
  syncDevices,
} from "../services/rotom.js";
import { rerunBootstrap, startBootstrap } from "../services/hostBootstrap.js";
import { adoptHost, convergeHost, setInstanceCount } from "../services/redroid.js";
import { nudge } from "../services/scheduler.js";
import { probeRemote, storeFromUrl, storeUpload } from "../services/uploads.js";
import { pollAllSources } from "../services/sources/poller.js";

const createRolloutBody = z.object({
  appVersionId: z.string(),
  deviceIds: z.array(z.string()).optional(),
  forceClean: z.boolean().optional(),
  preInstallHook: z.string().nullable().optional(),
  postInstallHook: z.string().nullable().optional(),
  hookMode: z.enum(["NORMAL", "POST_ONLY", "NONE"]).optional(),
  writeConfig: z.boolean().optional(),
  /** This rollout's own MITM config, standing in for the group's. */
  mitmConfig: z.string().nullable().optional(),
  canaryCount: z.number().int().min(0).optional(),
  soakMinutes: z.number().int().min(0).optional(),
  maxConcurrency: z.number().int().positive().nullable().optional(),
  maxAttempts: z.number().int().positive().optional(),
  retryBackoffSeconds: z.number().int().min(0).optional(),
  skipUpToDate: z.boolean().optional(),
  createdById: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

/**
 * Everything the dashboard needs the hub to actually do — anything that
 * touches a live socket or the scheduler. Plain reads go straight to the
 * database from the Next server instead of through here.
 */
export async function internalRoutes(app: FastifyInstance) {
  // An upload is a few hundred MB of binary. The app-wide parser buffers a
  // whole body before the handler runs, which is right for the small JSON
  // bodies everything else sends and catastrophic here, so octet-stream is
  // handed to the route as the raw stream instead. Registered inside this
  // plugin, so it applies to /internal/* only.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    // Caddy never routes /internal/authz here from the outside; it is called
    // by Caddy itself with the device's own bearer token.
    if (request.url.startsWith("/internal/authz")) return;

    const secret = request.headers["x-magnemite-secret"];
    if (secret !== env.HUB_INTERNAL_SECRET) {
      log.warn({ url: request.url, ip: request.ip }, "internal call rejected");
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/internal/status", async () => ({
    online: connectionCount(),
    onlineDeviceIds: onlineDeviceIds(),
    maxConcurrentJobs: (await getHubSettings()).maxConcurrentJobs,
  }));

  /**
   * Live probe of every integration, for the dashboard's Status page. Results
   * are cached hub-side; `force` is the operator pressing "Check again".
   */
  app.post("/internal/health", async (request) => {
    const body = (request.body ?? {}) as { force?: boolean };
    return collectHealth(body.force === true);
  });

  /**
   * Manual install: the dashboard streams an APK (or a multi-APK bundle)
   * straight through to here, and gets back an ordinary cached version it can
   * roll out. Metadata rides in the query string because the body is the file.
   */
  app.post<{
    Querystring: {
      packageName?: string;
      version?: string;
      filename?: string;
      displayName?: string;
      arch?: string;
    };
  }>("/internal/uploads", async (request, reply) => {
    const { packageName, version, filename, displayName, arch } = request.query;

    try {
      // Both optional: what the file's own manifest says stands in for either.
      const result = await storeUpload({
        stream: request.raw,
        filename: filename ?? "upload.apk",
        packageName,
        version,
        displayName: displayName ?? null,
        arch: arch ?? null,
      });
      return reply.send(result);
    } catch (err) {
      log.warn({ err, packageName, version }, "manual upload failed");
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * The same thing from a link.
   *
   * An upload has to fit through the operator's browser, the dashboard and
   * whatever proxy fronts it — and Cloudflare's free plan stops a body at
   * 100 MB, which a 250 MB bundle is not. Fetching it here skips all three.
   */
  const remoteBody = z.object({
    url: z.string().min(1),
    packageName: z.string().optional(),
    version: z.string().optional(),
    displayName: z.string().optional(),
    arch: z.string().optional(),
    filename: z.string().optional(),
  });

  app.post("/internal/uploads/probe", async (request, reply) => {
    const body = z.object({ url: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "a url is required" });

    try {
      return await probeRemote(body.data.url);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/internal/uploads/from-url", async (request, reply) => {
    const body = remoteBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "a url is required" });

    try {
      const result = await storeFromUrl({
        url: body.data.url,
        filename: body.data.filename ?? null,
        packageName: body.data.packageName,
        version: body.data.version,
        displayName: body.data.displayName ?? null,
        arch: body.data.arch ?? null,
      });
      return reply.send(result);
    } catch (err) {
      log.warn({ err, url: body.data.url }, "fetching a build from a link failed");
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/internal/nudge", async () => {
    nudge();
    return { ok: true };
  });

  /**
   * The dashboard has written new hub settings.
   *
   * It rings this rather than the hub re-reading on a timer, and the answer is
   * the confirmation the dashboard needs: no reply means it could not be told,
   * which it says out loud instead of leaving the hub quietly on old values.
   */
  app.post("/internal/settings", async () => {
    // Read before the drop: this is the only chance to see the old heartbeat,
    // and nothing else can say whether the save changed it.
    const before = peekHeartbeatSeconds();
    invalidateHubSettingsCache();

    // Every other knob here is the server's own and applies on the next read.
    // The heartbeat is not: it lives in a ticker on each box, set from the
    // `welcome`. Without this push the fleet keeps beating at the old rate
    // until each box happens to reconnect, while the offline sweep moves to
    // the new timeout at once — lower both together and a healthy fleet is
    // marked offline for as long as that gap lasts. A cold cache means nothing
    // has read the settings, which means no box has connected, so there is
    // nobody to push to.
    const after = (await getHubSettings()).heartbeatSeconds;
    const pushed = before !== null && before !== after ? await broadcastWelcome() : 0;
    return { ok: true, pushed };
  });

  // --- rollouts ------------------------------------------------------------

  app.post("/internal/rollouts", async (request, reply) => {
    const parsed = createRolloutBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", issues: parsed.error.issues });
    }
    try {
      const rollout = await createRollout(parsed.data);
      nudge();
      return reply.send(serialize({ id: rollout.id, jobs: rollout.jobs.length }));
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/internal/rollouts/:id/cancel", async (request) => {
    const cancelled = await cancelRollout(request.params.id);
    return { ok: true, cancelled };
  });

  app.post<{ Params: { id: string } }>("/internal/rollouts/:id/resume", async (request, reply) => {
    try {
      await resumeRollout(request.params.id);
      nudge();
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/internal/rollouts/:id/retry-failed", async (request) => {
    const retried = await retryFailedJobs(request.params.id);
    nudge();
    return { ok: true, retried };
  });

  // --- jobs ----------------------------------------------------------------

  app.post<{ Params: { id: string } }>("/internal/jobs/:id/retry", async (request) => {
    await retryJob(request.params.id);
    nudge();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/internal/jobs/:id/cancel", async (request) => {
    const job = await cancelJob(request.params.id);
    // Tell the agent to stop too, so it isn't still pulling 170 MB for a job
    // the dashboard already shows as cancelled.
    if (job) sendTo(job.deviceId, { type: "cancel_job", jobId: job.id });
    nudge();
    return { ok: true };
  });

  /**
   * Tell every connected box what to report versions for, and what to watch.
   * Called by the dashboard when the watched package list or a monitor rule
   * changes, so a new column fills in — and a rule starts being probed — on
   * the next heartbeat rather than whenever each box next reconnects.
   */
  app.post("/internal/tracked-packages/refresh", async () => ({
    sent: await broadcastWelcome(),
  }));

  // --- monitoring ----------------------------------------------------------

  /**
   * Prove the Discord webhook before anyone trusts it. Bypasses the level
   * filter and the dedupe window: somebody pressing "Send test alert" wants to
   * see a message, not to find out later that one was suppressed.
   */
  app.post("/internal/monitor/test", async () => sendTestAlert());

  /** Force an evaluation pass, for the dashboard's "Run now" and for testing. */
  app.post("/internal/monitor/run", async () => {
    await evaluate();
    return { ok: true };
  });

  // --- devices -------------------------------------------------------------

  app.post<{ Params: { id: string } }>("/internal/devices/:id/reboot", async (request, reply) => {
    const sent = sendTo(request.params.id, { type: "reboot" });
    if (!sent) return reply.status(409).send({ error: "device is offline" });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { url: string; sha256: string; version: string } }>(
    "/internal/devices/:id/agent-update",
    async (request, reply) => {
      const body = z
        .object({ url: z.string().url(), sha256: z.string().length(64), version: z.string() })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: "invalid body" });
      const sent = sendTo(request.params.id, { type: "agent_update", ...body.data });
      if (!sent) return reply.status(409).send({ error: "device is offline" });
      return { ok: true };
    },
  );

  /**
   * Run a command on a box and hand back what it printed.
   *
   * The same root shell the install hooks already get. Authorisation is the
   * dashboard's job — it only offers this to operators, and writes what was
   * run into the audit log.
   */
  app.post<{ Params: { id: string }; Body: { command: string; timeoutSeconds?: number } }>(
    "/internal/devices/:id/exec",
    async (request, reply) => {
      const body = z
        .object({
          command: z.string().min(1).max(4096),
          timeoutSeconds: z.number().int().positive().max(600).optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: "invalid body" });

      try {
        return await execOnDevice(request.params.id, body.data.command, body.data.timeoutSeconds);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(message === "device is offline" ? 409 : 500).send({ error: message });
      }
    },
  );

  /**
   * Ask a box for its logs and wait for the zip to land. The dashboard hands
   * the browser a download URL straight afterwards, so there is nothing here
   * to poll — the wait is the point.
   */
  app.post<{ Params: { id: string }; Body: { requestedById?: string | null } }>(
    "/internal/devices/:id/logs",
    async (request, reply) => {
      const body = (request.body ?? {}) as { requestedById?: string | null };
      try {
        return await requestBundle(request.params.id, body.requestedById ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(message === "device is offline" ? 409 : 504).send({ error: message });
      }
    },
  );

  app.get<{ Params: { id: string; bundleId: string } }>(
    "/internal/devices/:id/logs/:bundleId",
    async (request, reply) => {
      const bundle = await prisma.deviceLogBundle.findUnique({
        where: { id: request.params.bundleId },
        select: { deviceId: true, state: true, path: true, device: { select: { serial: true } } },
      });
      if (!bundle || bundle.deviceId !== request.params.id) {
        return reply.status(404).send({ error: "no such bundle" });
      }
      if (bundle.state !== "READY" || !bundle.path) {
        return reply.status(409).send({ error: `bundle is ${bundle.state.toLowerCase()}` });
      }

      const stat = await fsp.stat(bundle.path).catch(() => null);
      // The row outliving the file means the volume was wiped or the prune ran
      // between the request and the click.
      if (!stat?.isFile()) return reply.status(410).send({ error: "the bundle is gone" });

      reply.header("Content-Type", "application/zip");
      reply.header("Content-Length", String(stat.size));
      reply.header("X-Magnemite-Serial", bundle.device.serial);
      return reply.send(createReadStream(bundle.path));
    },
  );

  /**
   * Live logcat, as server-sent events. One logcat runs on the box however
   * many people are watching, and it stops when the last one closes the tab.
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/internal/devices/:id/logs/live",
    async (request, reply) => {
      let unsubscribe: (() => void) | null = null;
      try {
        const path = normaliseLogPath(request.query.path);

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        reply.raw.write(": connected\n\n");

        unsubscribe = subscribeToLogs(request.params.id, path, (chunk) => {
          reply.raw.write(`event: lines\ndata: ${JSON.stringify(chunk)}\n\n`);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The head is already written by the time a subscribe can fail, so the
        // error travels as an event rather than a status code.
        reply.raw.write(`event: fatal\ndata: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
        return reply;
      }

      const keepalive = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
      request.raw.on("close", () => {
        clearInterval(keepalive);
        unsubscribe?.();
      });

      // Never resolves; the stream stays open until the browser goes away.
      return reply;
    },
  );

  app.post<{ Params: { id: string; action: string } }>(
    "/internal/devices/:id/rotom/:action",
    async (request, reply) => {
      if (!rotomEnabled()) return reply.status(409).send({ error: "rotom integration is off" });

      const allowed: RotomAction[] = ["restart", "reboot", "enable", "disable", "disconnect"];
      const action = request.params.action as RotomAction;
      if (!allowed.includes(action)) return reply.status(400).send({ error: "unknown action" });

      const device = await prisma.device.findUnique({
        where: { id: request.params.id },
        select: { rotomDeviceId: true },
      });
      if (!device?.rotomDeviceId) {
        return reply.status(409).send({ error: "this device is not matched to a rotom device" });
      }

      const ok = await deviceAction(device.rotomDeviceId, action);
      if (!ok) return reply.status(502).send({ error: `rotom refused the ${action}` });
      return { ok: true };
    },
  );

  /**
   * One box's workers, as the last fleet sync saw them.
   *
   * Served from memory rather than by asking Rotom: the sync already fetches
   * every worker of every box, so a second call for one box would be paying
   * twice for the same rows — and it would be paid on every re-render of a page
   * somebody left open. Nothing is stored either; the sync keeps three numbers
   * on the device row for the rules, and this is the breakdown behind them.
   *
   * `readAt` is null when the sync has not reached this box yet, which the page
   * shows as "no reading" rather than as a box with no workers.
   */
  // POST like the rest of /internal, which is an RPC surface rather than a REST
  // one — the web client only knows how to speak to it that way.
  app.post<{ Params: { id: string } }>(
    "/internal/devices/:id/rotom/workers",
    async (request, reply) => {
      if (!rotomEnabled()) return reply.status(409).send({ error: "rotom integration is off" });

      const device = await prisma.device.findUnique({
        where: { id: request.params.id },
        select: { rotomDeviceId: true },
      });
      if (!device?.rotomDeviceId) {
        return reply.status(409).send({ error: "this device is not matched to a rotom device" });
      }

      const cached = cachedWorkers(request.params.id);
      return { workers: cached?.workers ?? [], readAt: cached?.at ?? null };
    },
  );

  app.post("/internal/rotom/sync", async (request, reply) => {
    if (!rotomEnabled()) return reply.status(409).send({ error: "rotom integration is off" });
    const result = await syncDevices();
    return { ok: true, ...result };
  });

  // --- versions ------------------------------------------------------------

  app.post<{ Params: { id: string } }>("/internal/versions/:id/cache", async (request, reply) => {
    const version = await prisma.appVersion.findUnique({ where: { id: request.params.id } });
    if (!version) return reply.status(404).send({ error: "version not found" });
    // Downloading 250 MB takes minutes; kick it off and let the dashboard
    // follow cacheProgress over SSE.
    void cacheVersion(version.id).catch((err) => log.error({ err }, "cacheVersion failed"));
    return { ok: true };
  });

  app.post("/internal/versions/prune", async (request) => {
    const body = z
      .object({ keepLatest: z.number().int().min(1).optional() })
      .safeParse(request.body);
    const removed = await pruneArtifacts(body.success ? body.data.keepLatest : undefined);
    return { ok: true, removed };
  });

  // Awaited, unlike the scheduled pass: a person pressed a button and is
  // watching, so the answer is what the poll found rather than "accepted".
  app.post("/internal/sources/poll", async (_request, reply) => {
    try {
      return await pollAllSources();
    } catch (err) {
      log.error({ err }, "manual poll failed");
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Redroid machines ----------------------------------------------------
  //
  // These are here rather than as server actions for the usual reason: they
  // need a live socket. The rows a scale writes are the desired state and the
  // dashboard could write them itself, but nothing would reach the machine.

  /**
   * Bring a machine to N instances, then converge it.
   *
   * The scale and the converge are one call because an operator pressing Save
   * means both, and leaving them separate would make "I changed the number and
   * nothing happened" the normal experience.
   */
  app.post("/internal/hosts/:id/scale", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        // Zero is valid and is how a machine is drained — not a mistake to
        // refuse. The upper bound is a sanity rail, not a capacity limit;
        // capacity is advice the form gives, and the operator may know better.
        count: z.number().int().min(0).max(64),
        workers: z.number().int().min(1).max(50).nullable().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", issues: parsed.error.issues });
    }

    try {
      const changed = await setInstanceCount(id, parsed.data.count, parsed.data.workers ?? null);
      const converge = await convergeHost(id);
      return { ...changed, ...converge };
    } catch (err) {
      log.error({ err, hostId: id }, "scale failed");
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Provision a machine over SSH, from the moment its provider handed over
   * access.
   *
   * Returns as soon as the run starts. The SSH half is minutes -- apt, Docker,
   * kernel modules, possibly a reboot -- so the row carries the progress and
   * the dashboard renders that rather than holding a connection open for it.
   *
   * The credential is used once and never stored, which is why it travels in
   * the body of this call and appears in no row, no log and no audit entry.
   */
  app.post("/internal/hosts/bootstrap", async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(64),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().min(1),
        password: z.string().min(1).optional(),
        privateKey: z.string().min(1).optional(),
        passphrase: z.string().optional(),
        desiredInstances: z.number().int().min(0).max(64).default(0),
        desiredWorkers: z.number().int().min(1).max(50).nullable().optional(),
      })
      // One or the other. Neither means there is no way in, and without this
      // the failure would be a timeout twenty minutes later.
      .refine((body) => Boolean(body.password || body.privateKey), {
        message: "a password or a private key is required",
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", issues: parsed.error.issues });
    }

    const { name, host, port, username, password, privateKey, passphrase } = parsed.data;
    try {
      return await startBootstrap({
        name,
        access: { host, port, username, password, privateKey, passphrase },
        desiredInstances: parsed.data.desiredInstances,
        desiredWorkers: parsed.data.desiredWorkers ?? null,
      });
    } catch (err) {
      // Deliberately not logging the error object: the credential is in the
      // call that produced it, and an exception can carry its own input.
      log.error({ name, host }, "could not start the bootstrap");
      return reply.status(500).send({ error: err instanceof Error ? err.message : "failed" });
    }
  });

  /** Import the containers a machine already has, so a first converge is safe. */
  app.post("/internal/hosts/:id/adopt", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await adoptHost(id);
    } catch (err) {
      // A 400 rather than a 500: every failure here is a precondition the
      // operator can act on — offline, already adopted, no report yet.
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Converge without changing anything, which is the "re-apply" button.
   *
   * `force` sends the file even when its hash already matches, for the case
   * where the machine and the hub agree on paper and the containers still are
   * not what they should be.
   */
  /**
   * Run the provisioning script again on a machine that is already up.
   *
   * The files travel with the request, so this is how a *fixed* image reaches
   * a machine that already exists — the copies on the machine are the ones
   * being replaced. It returns as soon as the request is sent: the run itself
   * is minutes, and what it did lands on the machine's row when it reports.
   */
  app.post("/internal/hosts/:id/bootstrap", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await rerunBootstrap(id);
    } catch (err) {
      log.error({ err, hostId: id }, "bootstrap re-run failed");
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/internal/hosts/:id/converge", async (request, reply) => {
    const { id } = request.params as { id: string };
    const force = (request.body as { force?: boolean } | undefined)?.force === true;
    try {
      return await convergeHost(id, { force });
    } catch (err) {
      log.error({ err, hostId: id }, "converge failed");
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
