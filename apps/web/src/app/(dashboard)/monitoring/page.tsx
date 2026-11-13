import { getMonitorSettings, prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { MonitorActivity } from "@/components/monitor-activity";

export const dynamic = "force-dynamic";

/**
 * What the monitor rules did, fleet-wide.
 *
 * Its own page rather than a card under Settings: it answers an operational
 * question, it grows all day on a fleet with monitoring on, and nobody goes to
 * a settings tab to read a feed. The rules themselves stay in
 * Settings → Monitoring, which is where they belong.
 */
export default async function MonitoringPage() {
  const user = await requireUser();

  const [settings, events, enabledRules] = await Promise.all([
    getMonitorSettings(),
    prisma.monitorEvent.findMany({
      orderBy: { at: "desc" },
      // Paged client-side, so this caps how far back the feed goes rather than
      // what fits on screen. Retention is the real limit.
      take: 500,
      include: {
        device: { select: { id: true, name: true, group: { select: { name: true } } } },
      },
    }),
    prisma.monitorRule.count({ where: { enabled: true } }),
  ]);

  // The rule names in one pass rather than a join per row: an event keeps its
  // ruleId after the rule is deleted, so this is a lookup, not a relation.
  const ruleNames = new Map(
    (await prisma.monitorRule.findMany({ select: { id: true, name: true } })).map((rule) => [
      rule.id,
      rule.name,
    ]),
  );

  return (
    <MonitorActivity
      enabled={settings.enabled}
      ruleCount={enabledRules}
      canOperate={user.role !== "VIEWER"}
      events={events.map((event) => ({
        id: event.id,
        at: event.at.toISOString(),
        deviceId: event.device.id,
        deviceName: event.device.name,
        groupName: event.device.group?.name ?? null,
        ruleName: event.ruleId ? (ruleNames.get(event.ruleId) ?? null) : null,
        signal: event.signal,
        level: event.level,
        message: event.message,
        action: event.action,
        actionOk: event.actionOk,
        detail: event.detail,
        notified: event.notified,
        recovery: event.recovery,
      }))}
    />
  );
}
