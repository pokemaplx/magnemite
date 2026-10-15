import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { hashToken, prisma } from "@magnemite/db";
import { log } from "../log.js";
import {
  completeScreenshot,
  failScreenshot,
  screenshotDir,
  screenshotPath,
} from "../services/deviceScreenshots.js";

/**
 * Where a box uploads the screenshot it was asked for.
 *
 * The log bundle route's twin, down to the authentication: public like
 * `/api/enroll`, and authenticated the way everything a box does is — with its
 * own device token. The id in the path is not a capability; the token has to
 * belong to the device that capture was asked of, or this is a 401.
 */

/**
 * A 1080p PNG off `screencap` is well under this.
 *
 * Android writes them unoptimised, so a busy screen is a megabyte or two and a
 * 4K television is a few more. Eight is roomy and still small enough that a box
 * with something badly wrong cannot fill the volume one capture at a time.
 */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export async function screenshotRoutes(app: FastifyInstance) {
  // The body is a PNG, and the app-wide parser would buffer it whole before the
  // handler ran. Same trick as the log bundle and the manual upload routes.
  app.addContentTypeParser("image/png", (_request, payload, done) => {
    done(null, payload);
  });

  app.post<{ Params: { screenshotId: string } }>(
    "/api/screenshots/:screenshotId",
    async (request, reply) => {
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
      if (!token) return reply.status(401).send({ error: "unauthorized" });

      const [device, shot] = await Promise.all([
        prisma.device.findUnique({
          where: { tokenHash: hashToken(token) },
          select: { id: true, approved: true },
        }),
        prisma.deviceScreenshot.findUnique({
          where: { id: request.params.screenshotId },
          select: { id: true, deviceId: true, state: true },
        }),
      ]);

      if (!device?.approved) return reply.status(401).send({ error: "unauthorized" });
      if (!shot || shot.deviceId !== device.id) {
        return reply.status(404).send({ error: "no such screenshot" });
      }
      if (shot.state !== "PENDING") {
        return reply.status(409).send({ error: "that screenshot is already closed" });
      }

      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_SCREENSHOT_BYTES) {
        await failScreenshot(shot.id, `the capture is too large (${declared} bytes)`);
        return reply.status(413).send({ error: "screenshot too large" });
      }

      await fs.mkdir(screenshotDir(device.id), { recursive: true });
      const dest = screenshotPath(device.id, shot.id);
      const tmp = `${dest}.part`;

      let written = 0;
      try {
        const sink = createWriteStream(tmp);
        request.raw.on("data", (chunk: Buffer) => {
          written += chunk.length;
          // Content-Length can lie, so the real cap is enforced as it arrives.
          if (written > MAX_SCREENSHOT_BYTES) {
            request.raw.destroy(new Error("screenshot too large"));
          }
        });
        await pipeline(request.raw, sink);
        await fs.rename(tmp, dest);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err, deviceId: device.id, screenshotId: shot.id }, "screenshot upload failed");
        await failScreenshot(shot.id, `upload failed: ${message}`);
        return reply.status(400).send({ error: message });
      }

      await completeScreenshot(shot.id, dest, written);
      log.info(
        { deviceId: device.id, screenshotId: shot.id, bytes: written },
        "screenshot received",
      );
      return { ok: true };
    },
  );
}
