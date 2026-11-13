import {
  getHubSettings as readHubSettings,
  getMonitorSettings as readMonitorSettings,
  getNotifyRoutes as readNotifyRoutes,
  getNotifySettings as readNotifySettings,
  type HubSettingsValues,
  type MonitorSettingsValues,
  type NotifyRoutes,
  type NotifySettingsValues,
} from "@magnemite/db";
import { log } from "../log.js";

/**
 * The hub's copy of the fleet-wide settings.
 *
 * The scheduler reads these on every tick *and* on every nudge — a job
 * finishing, a box reconnecting — so during a rollout this is the hottest read
 * in the system, for a handful of numbers that change about never. That is why
 * the hub caches, and why nothing else does: the dashboard reads them once per
 * page render and has no such pressure.
 *
 * Held until something says it is stale, rather than re-read on a timer. Two
 * things clear it, and between them they cover everything that can change the
 * values:
 *
 *   the dashboard   writes them, then rings /internal/settings
 *   a restart       starts with nothing and reads on first use
 *
 * What that leaves is a value changed straight in the database by hand with no
 * restart after. That one needs a restart, or one Save from the dashboard to
 * ring the bell — a manual change with a manual fix, which is not worth a
 * query every few seconds forever.
 */
let cache: HubSettingsValues | null = null;
let monitorCache: MonitorSettingsValues | null = null;
let notifyCache: NotifySettingsValues | null = null;
let routesCache: NotifyRoutes | null = null;

export async function getHubSettings(): Promise<HubSettingsValues> {
  if (cache) return { ...cache };
  const values = await readHubSettings();
  cache = values;
  return { ...values };
}

/**
 * The monitoring knobs, held the same way and for the same reason: the
 * evaluation pass reads all of them, and most are ceilings it has to check
 * before it is allowed to touch a box.
 */
export async function getMonitorSettings(): Promise<MonitorSettingsValues> {
  if (monitorCache) return { ...monitorCache };
  const values = await readMonitorSettings();
  monitorCache = values;
  return { ...values };
}

/**
 * The channels, and which fleet event goes to which of them.
 *
 * Cached because they are asked on every job that finishes: a rollout's last
 * job is the moment it is announced, and the question "does anything want to
 * hear about this" comes before any of the queries that would build the
 * message.
 */
export async function getNotifySettings(): Promise<NotifySettingsValues> {
  if (notifyCache) return { ...notifyCache };
  const values = await readNotifySettings();
  notifyCache = values;
  return { ...values };
}

export async function getNotifyRoutes(): Promise<NotifyRoutes> {
  if (routesCache) return { ...routesCache };
  const values = await readNotifyRoutes();
  routesCache = values;
  return { ...values };
}

/**
 * Drop every copy, so the next read goes to the database.
 *
 * One bell for all the groups: the dashboard rings it after any save, and a
 * cache that is dropped when it did not need to be costs one query.
 */
export function invalidateHubSettingsCache(): void {
  cache = null;
  monitorCache = null;
  notifyCache = null;
  routesCache = null;
  log.info("hub settings cache dropped");
}

/**
 * The heartbeat interval the hub is holding right now, with no database read —
 * `null` when nothing has read the settings yet.
 *
 * One caller: `/internal/settings`, which has to know whether a save changed
 * the heartbeat *before* it drops the copy. That is the only setting here the
 * boxes hold rather than the server, so it is the only one that needs pushing.
 */
export function peekHeartbeatSeconds(): number | null {
  return cache?.heartbeatSeconds ?? null;
}
