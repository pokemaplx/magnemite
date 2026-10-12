import type { FastifyInstance } from "fastify";
import { enrollRequestSchema } from "@magnemite/protocol";
import { generateToken, hashToken, prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";

function defaultName(serial: string, manufacturer?: string | null, model?: string | null) {
  const label = [manufacturer, model].filter(Boolean).join(" ").trim();
  const tail = serial.slice(-6);
  return label ? `${label} ${tail}` : `device ${tail}`;
}

export async function enrollRoutes(app: FastifyInstance) {
  /**
   * First contact from a freshly flashed box. It presents the shared
   * enrollment token and gets back a token of its own, which is what every
   * later request authenticates with.
   */
  app.post("/api/enroll", async (request, reply) => {
    const parsed = enrollRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", issues: parsed.error.issues });
    }
    const body = parsed.data;

    const enrollment = await prisma.enrollmentToken.findUnique({
      where: { tokenHash: hashToken(body.enrollmentToken) },
    });
    if (!enrollment || enrollment.revoked) {
      log.warn({ ip: request.ip, serial: body.device.serial }, "enrollment rejected: bad token");
      return reply.status(401).send({ error: "invalid enrollment token" });
    }
    if (enrollment.expiresAt && enrollment.expiresAt < new Date()) {
      return reply.status(401).send({ error: "enrollment token expired" });
    }
    if (enrollment.maxUses !== null && enrollment.uses >= enrollment.maxUses) {
      return reply.status(401).send({ error: "enrollment token exhausted" });
    }

    const deviceToken = generateToken();
    const existing = await prisma.device.findUnique({ where: { serial: body.device.serial } });

    const kind = enrollment.kind;

    // A Redroid container's serial was minted by the hub, on an instance row,
    // before the container existed. Finding one here is what tells us this is
    // a managed instance rather than a box somebody flashed -- and it carries
    // the site the machine belongs to.
    //
    // Without this the create below hard-codes `default`, and the first
    // rollout to reach the box writes *default's* MITM config, with the
    // sha256 read-back faithfully confirming the wrong file.
    const instance =
      kind === "BOX"
        ? await prisma.redroidInstance.findUnique({
            where: { serial: body.device.serial },
            select: { id: true, host: { select: { defaultGroupId: true } } },
          })
        : null;

    // A host belongs to no group: a group is a site with a MITM config and
    // install hooks, and a machine runs neither.
    const group =
      kind === "HOST"
        ? undefined
        : instance?.host.defaultGroupId
          ? { connect: { id: instance.host.defaultGroupId } }
          : {
              connectOrCreate: {
                where: { name: "default" },
                create: { name: "default" },
              },
            };

    // Re-enrollment (box re-flashed, agent config wiped) keeps the same row so
    // its history, name and group survive. Only the token rotates.
    const device = existing
      ? await prisma.device.update({
          where: { id: existing.id },
          data: {
            tokenHash: hashToken(deviceToken),
            agentVersion: body.agentVersion,
            manufacturer: body.device.manufacturer ?? undefined,
            model: body.device.model ?? undefined,
            androidVersion: body.device.androidVersion ?? undefined,
            sdkInt: body.device.sdkInt ?? undefined,
            abi: body.device.abi ?? undefined,
            localIp: body.device.localIp ?? undefined,
            name: body.name ?? existing.name,
            // The token's scope decides, so a row re-enrolled under a host
            // token is corrected rather than left mislabelled.
            kind,
            ...(kind === "HOST" ? { approved: true } : {}),
          },
        })
      : await prisma.device.create({
          data: {
            serial: body.device.serial,
            kind,
            name:
              body.name ??
              defaultName(body.device.serial, body.device.manufacturer, body.device.model),
            tokenHash: hashToken(deviceToken),
            // A host is always approved. `/internal/authz` refuses an
            // unapproved device, so a machine that enrolled pending would get
            // a bare 401 from the edge on its first self-update with nothing
            // anywhere to say why. The HOST token scope forces `autoApprove`
            // for the same reason; this is the belt to that brace.
            approved: kind === "HOST" ? true : enrollment.autoApprove,
            agentVersion: body.agentVersion,
            manufacturer: body.device.manufacturer ?? null,
            model: body.device.model ?? null,
            androidVersion: body.device.androidVersion ?? null,
            sdkInt: body.device.sdkInt ?? null,
            abi: body.device.abi ?? null,
            localIp: body.device.localIp ?? null,
            group,
          },
        });

    await prisma.enrollmentToken.update({
      where: { id: enrollment.id },
      data: { uses: { increment: 1 } },
    });

    // A host needs its satellite row, which carries the compose project and
    // the per-machine defaults a box has no use for. Upserted rather than
    // created, because a machine that re-enrolls after losing its config must
    // keep the instances already sitting on it as containers and volumes --
    // creating a fresh row would orphan every one of them.
    if (kind === "HOST") {
      await prisma.redroidHost.upsert({
        where: { deviceId: device.id },
        create: { deviceId: device.id },
        update: {},
      });
    }

    // Claim the instance for the box it has become. Until this runs the
    // instance reads as "running, not enrolled", which is the state an
    // operator setting a machine up most needs to be able to see -- and the
    // one nothing could distinguish from "not running" before.
    //
    // Written on re-enrollment too: a container whose /data volume was lost
    // comes back as the same Device by serial, and the link has to survive
    // that rather than being a one-shot at creation.
    if (instance) {
      await prisma.redroidInstance.update({
        where: { id: instance.id },
        data: { deviceId: device.id },
      });
    }

    log.info(
      { deviceId: device.id, serial: device.serial, reEnrolled: Boolean(existing) },
      "device enrolled",
    );
    bus.publish({ kind: "device", deviceId: device.id });

    const wsUrl = `${env.MAGNEMITE_PUBLIC_URL.replace(/^http/, "ws").replace(/\/$/, "")}/ws/device`;
    return reply.send({
      deviceId: device.id,
      deviceToken,
      name: device.name,
      approved: device.approved,
      wsUrl,
    });
  });
}
