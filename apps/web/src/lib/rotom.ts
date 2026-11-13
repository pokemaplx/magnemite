/**
 * What Rotom's numbers mean, in one place.
 *
 * The fleet table's Scanner cell, its sort and the device page's card all have
 * to agree about when a box is `idle` rather than `stalled`, and a second copy
 * of that precedence is a second thing to keep in step. They differ in what
 * they draw, not in what they conclude.
 */

export type RotomView = {
  connected: boolean;
  enabled: boolean;
  workers: number | null;
  workersInUse: number | null;
  /** Null when Rotom does not measure rates, which is a mode, not a zero. */
  requestRate: number | null;
};

export type ScannerState =
  "unmatched" | "notConnected" | "disabled" | "idle" | "stalled" | "scanning";

/**
 * The order of the checks *is* the precedence: a box someone disabled in Rotom
 * is labelled that whatever else is true of it, since it is a decision rather
 * than a fault, and `idle` outranks `stalled` because nothing allocated already
 * explains everything a zero request rate would.
 */
export function scannerState(rotom: RotomView | null): ScannerState {
  if (!rotom) return "unmatched";
  if (!rotom.enabled) return "disabled";
  if (!rotom.connected) return "notConnected";
  if (rotom.workersInUse === 0) return "idle";
  if (rotom.workersInUse !== null && rotom.requestRate === 0) return "stalled";
  return "scanning";
}

/** Healthiest last, so a descending sort brings the boxes worth looking at up. */
export const SCANNER_RANK: Record<ScannerState, number> = {
  unmatched: 0,
  notConnected: 1,
  disabled: 2,
  idle: 3,
  stalled: 4,
  scanning: 5,
};

export const SCANNER_LABEL: Record<ScannerState, string> = {
  unmatched: "not matched",
  notConnected: "not scanning",
  disabled: "disabled",
  idle: "idle",
  stalled: "stalled",
  scanning: "scanning",
};

/** Why, for the tooltip — the states that are not self-explanatory. */
export const SCANNER_TITLE: Partial<Record<ScannerState, string>> = {
  unmatched: "No matching device in Rotom",
  disabled: "Someone took this box out of Rotom's pool on purpose",
  idle: "Connected, and Rotom has nothing allocated on it",
  stalled: "A worker is allocated and no requests are going through it",
};

export const SCANNER_VARIANT: Record<ScannerState, "success" | "warning" | "outline"> = {
  unmatched: "outline",
  notConnected: "outline",
  disabled: "outline",
  idle: "warning",
  stalled: "warning",
  scanning: "success",
};

/** "· 2/4w", or "· 4w" on a Rotom that counts workers but not allocations. */
export function workerLabel(rotom: RotomView): string {
  if (rotom.workers === null) return "";
  if (rotom.workersInUse === null) return ` · ${rotom.workers}w`;
  return ` · ${rotom.workersInUse}/${rotom.workers}w`;
}

/**
 * Detects whether a device, group, or MITM configuration is operating in RPC mode
 * (direct protocol worker without game client interaction).
 */
export function isRpcMode(
  packageName?: string | null,
  label?: string | null,
  config?: string | null,
): boolean {
  if (
    packageName === "com.pokemaplx.zoroark.direct" ||
    packageName === "lunala" ||
    packageName === "org.cosmog.lunala"
  ) {
    return true;
  }
  if (label && (/rpc/i.test(label) || /direct/i.test(label) || /lunala/i.test(label))) return true;
  if (
    config &&
    (config.includes('"backend": "direct"') ||
      config.includes('"backend":"direct"') ||
      config.includes('backend = "direct"') ||
      config.includes('"backend": "rpc"') ||
      config.includes('"backend":"rpc"') ||
      config.includes('backend = "rpc"') ||
      config.includes('rotom_worker_endpoint') ||
      config.includes('[rotom]'))
  ) {
    return true;
  }
  return false;
}

/** Backward compatibility alias. */
export const isDirectMitm = isRpcMode;
