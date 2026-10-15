import { prisma } from "@magnemite/db";
import { StateStrip } from "@/components/charts/state-strip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CAUSE_DETAIL } from "@/lib/connectivity";

const HALF_WINDOW_MS = 15 * 60 * 1000;
const SLOTS = 60; // thirty minutes at thirty-second resolution

/**
 * The half hour around one alert, from everything that was writing at the time.
 *
 * This is what the whole connectivity record exists to produce. The two bands
 * are the diagnosis and neither says it alone: Rotom keeps recording on its
 * own clock while the agent is mute, so "the agent stopped and Rotom kept
 * seeing the box" and "both lost it at once" are different faults that look
 * identical from the alert.
 */
export async function IncidentWindow({ deviceId, at }: { deviceId: string; at: Date }) {
  const from = new Date(at.getTime() - HALF_WINDOW_MS);
  const to = new Date(at.getTime() + HALF_WINDOW_MS);

  const [episodes, samples, rotom, events, updates, jobs] = await Promise.all([
    prisma.deviceConnectionEvent.findMany({
      where: {
        deviceId,
        startedAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      },
      orderBy: { startedAt: "asc" },
    }),
    prisma.deviceMetricSample.findMany({
      where: { deviceId, at: { gte: from, lte: to } },
      select: { at: true },
    }),
    prisma.rotomSample.findMany({
      where: { deviceId, at: { gte: from, lte: to } },
      select: { at: true, connected: true },
    }),
    prisma.monitorEvent.findMany({
      where: { deviceId, at: { gte: from, lte: to } },
      orderBy: { at: "asc" },
      select: { at: true, signal: true, message: true, recovery: true, level: true },
    }),
    prisma.agentUpdate.findMany({
      where: { deviceId, sentAt: { gte: from, lte: to } },
      select: { sentAt: true, toVersion: true, state: true },
    }),
    prisma.job.findMany({
      where: { deviceId, queuedAt: { gte: from, lte: to } },
      select: { queuedAt: true, state: true, toVersion: true },
    }),
  ]);

  const slotMs = (HALF_WINDOW_MS * 2) / SLOTS;
  const slotStart = (i: number) => from.getTime() + i * slotMs;

  const reporting: (boolean | null)[] = [];
  const rotomSeen: (boolean | null)[] = [];
  for (let i = 0; i < SLOTS; i += 1) {
    const start = slotStart(i);
    const end = start + slotMs;
    reporting.push(samples.some((s) => s.at.getTime() >= start && s.at.getTime() < end));
    const inSlot = rotom.filter((r) => r.at.getTime() >= start && r.at.getTime() < end);
    // Null, not false: Rotom not being asked in a slot is not Rotom saying no.
    rotomSeen.push(inSlot.length === 0 ? null : inSlot.some((r) => r.connected));
  }

  const episode = episodes.find((e) => e.cause !== "HUB_RESTART") ?? episodes[0];
  const anyRotom = rotomSeen.some((v) => v !== null);
  const rotomHeld = anyRotom && rotomSeen.some((v) => v === true);
  const quiet = reporting.filter((v) => v === false).length;

  const timeline = [
    ...episodes.map((e) => ({
      at: e.startedAt,
      text: `lost contact${e.closeCode !== null ? ` (socket closed, code ${e.closeCode})` : " (socket stayed open)"}`,
    })),
    ...episodes.filter((e) => e.endedAt).map((e) => ({ at: e.endedAt!, text: "back in contact" })),
    ...events.map((e) => ({
      at: e.at,
      text: `${e.recovery ? "recovered: " : ""}${e.message} (${e.signal})`,
    })),
    ...updates.map((u) => ({ at: u.sentAt, text: `agent update to ${u.toVersion} — ${u.state}` })),
    ...jobs.map((j) => ({ at: j.queuedAt, text: `install queued: ${j.toVersion} — ${j.state}` })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <Card>
      <CardHeader>
        <CardTitle>What happened around {at.toLocaleString()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p>{verdict({ episode, rotomHeld, anyRotom, quiet, slotMs })}</p>

        <div className="flex flex-col gap-2">
          <Row label="Agent reporting" values={reporting} />
          <Row label="Rotom saw the box" values={rotomSeen} />
          <p className="text-xs text-muted-foreground">
            Thirty minutes, thirty seconds a slot. Rotom is written on its own clock, so it keeps
            recording while the agent is silent — which is what separates a wedged agent from a box
            that really went away.
          </p>
        </div>

        {timeline.length > 0 ? (
          <ol className="flex flex-col gap-1 border-t pt-3 text-xs">
            {timeline.map((item, i) => (
              <li key={i} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <span className="font-mono text-muted-foreground">
                  {item.at.toLocaleTimeString()}
                </span>
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing else was written in this window.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** The one sentence the whole feature exists to produce. */
function verdict({
  episode,
  rotomHeld,
  anyRotom,
  quiet,
  slotMs,
}: {
  episode: { cause: string | null; closeCode: number | null } | undefined;
  rotomHeld: boolean;
  anyRotom: boolean;
  quiet: number;
  slotMs: number;
}): string {
  if (!episode) {
    return "No loss of contact was recorded in this window — whatever the alert was about, the hub never lost the box.";
  }

  const quietFor = Math.round((quiet * slotMs) / 1000);
  const parts: string[] = [];

  if (episode.closeCode === null) {
    parts.push("The socket stayed open the whole time");
  } else {
    parts.push(`The connection dropped (close code ${episode.closeCode})`);
  }

  if (anyRotom) {
    parts.push(rotomHeld ? "and Rotom kept seeing the box" : "and Rotom lost it too");
  }

  const base = `${parts.join(" ")}; the agent stopped reporting for about ${quietFor}s.`;
  const cause = episode.cause ? ` ${CAUSE_DETAIL[episode.cause as keyof typeof CAUSE_DETAIL]}` : "";
  return base + cause;
}

function Row({ label, values }: { label: string; values: (boolean | null)[] }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <StateStrip values={values} width={320} height={12} />
    </div>
  );
}
