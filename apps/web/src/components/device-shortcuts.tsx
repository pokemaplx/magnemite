"use client";

import { useRouter } from "next/navigation";
import { useHotkey } from "@/components/shortcuts/hotkeys";

export type DevicePage = "overview" | "rotom" | "metrics" | "connectivity";

/**
 * `1` to `4` between a box's own pages, which are separate routes rather than
 * tabs on one — each is reached from a button on a card, and this is the way
 * across without going back up first.
 *
 * The page being looked at leaves its own key unbound, and so does the scanner
 * page of a box Rotom never matched, which has nothing on it.
 */
export function DeviceShortcuts({
  deviceId,
  current,
  hasRotom,
}: {
  deviceId: string;
  current: DevicePage;
  hasRotom: boolean;
}) {
  const router = useRouter();
  const go = (suffix: string) => router.push(`/devices/${deviceId}${suffix}`);

  useHotkey("device.overview", () => go(""), { enabled: current !== "overview" });
  useHotkey("device.rotom", () => go("/rotom"), { enabled: hasRotom && current !== "rotom" });
  useHotkey("device.metrics", () => go("/metrics"), { enabled: current !== "metrics" });
  useHotkey("device.connectivity", () => go("/connectivity"), {
    enabled: current !== "connectivity",
  });

  return null;
}
