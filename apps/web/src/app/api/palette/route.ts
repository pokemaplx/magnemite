import { CAPABILITY_SCREENSHOT, hasCapability } from "@magnemite/protocol";
import { prisma } from "@magnemite/db";
import { getSession } from "@/lib/session";
import type { PaletteData } from "@/lib/palette";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the command palette can jump to that lives in the database.
 *
 * A route rather than a server action: a client's actions run one at a time,
 * so the palette would sit behind a logcat collection — up to two minutes —
 * before it could list a single box. Fetched each time the palette opens, so
 * it is never a stale copy of the fleet; the palette shows the last answer
 * while the next one is on its way.
 *
 * Any signed-in user: a viewer can open every page this points at. The
 * palette hides the actions from them, and the actions refuse them anyway.
 */
export async function GET() {
  const user = await getSession();
  if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

  const devices = await prisma.device.findMany({
    select: {
      id: true,
      name: true,
      serial: true,
      manufacturer: true,
      model: true,
      kind: true,
      status: true,
      approved: true,
      rotomDeviceId: true,
      capabilities: true,
      group: { select: { name: true } },
    },
    orderBy: { name: "asc" },
  });

  const data: PaletteData = { boxes: [], hosts: [] };
  for (const device of devices) {
    const online = device.status === "ONLINE";
    if (device.kind === "HOST") {
      data.hosts.push({ id: device.id, name: device.name, online });
      continue;
    }
    data.boxes.push({
      id: device.id,
      name: device.name,
      serial: device.serial,
      model: [device.manufacturer, device.model].filter(Boolean).join(" ") || null,
      groupName: device.group?.name ?? null,
      online,
      approved: device.approved,
      hasRotom: device.rotomDeviceId !== null,
      canScreenshot: hasCapability(device.capabilities, CAPABILITY_SCREENSHOT),
    });
  }

  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
