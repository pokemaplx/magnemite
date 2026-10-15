import type { DeviceConnectionCause } from "@magnemite/db";

/**
 * What a stretch of lost contact actually was, decided from its two ends.
 *
 * Kept apart from the service that applies it, and importing nothing but a
 * type, for the reason `sys.uptimeSeconds` sits beside the method that reads
 * /proc: this is a decision table, not an effect, and a decision table is
 * worth being able to exercise directly. The service does the I/O and hands
 * the facts here.
 */
export type ConnectionFacts = {
  /** The hub's own process started after the gap began. */
  hubRestarted: boolean;
  /** Null when the socket never closed, which is itself the evidence. */
  closeCode: number | null;
  /** The hub hung up because two keepalives went unanswered. */
  wasTerminated: boolean;
  durationSeconds: number;
  heartbeatSeconds: number;
  uptimeBefore: number | null;
  uptimeAfter: number | null;
  bootedAtBefore: Date | null;
  bootedAtAfter: Date | null;
  agentStartedBefore: Date | null;
  agentStartedAfter: Date | null;
};

/**
 * First match wins, and the order is the precedence of the *evidence* rather
 * than of the symptom: a hub that was down says nothing about the box, a close
 * code the hub itself chose outranks anything inferred, and only then does the
 * box's own account of its boot get a say.
 */
export function classify(f: ConnectionFacts): DeviceConnectionCause {
  if (f.hubRestarted) return "HUB_RESTART";
  if (f.closeCode === 4004) return "DEVICE_DELETED";
  if (f.closeCode === 4000) return "REPLACED";
  if (rebooted(f)) return "REBOOT";
  if (
    f.agentStartedBefore !== null &&
    f.agentStartedAfter !== null &&
    f.agentStartedBefore.getTime() !== f.agentStartedAfter.getTime()
  ) {
    return "AGENT_RESTART";
  }
  // The socket never closed, so nothing disconnected: the beats simply
  // stopped. This is the fault that used to be announced as unreachable.
  if (f.closeCode === null && !f.wasTerminated) return "HEARTBEAT_STALL";
  if (f.wasTerminated) return "TERMINATED_BY_HUB";
  return "LINK_LOST";
}

/**
 * Did the box itself restart?
 *
 * `bootedAt` is the primary test once the agent is new enough to send it: it
 * is a wall-clock instant and does not move just because a beat was slow.
 * Uptime is the fallback for an older agent, and stays on afterwards as a
 * cross-check — an NTP correction can shift `bootedAt`, which is also why both
 * tests share a tolerance rather than demanding equality.
 */
export function rebooted(f: ConnectionFacts): boolean {
  // Two beats or a minute, whichever is more. It has to absorb integer
  // truncation, two clocks, and a beat generated well before it was sent — a
  // beat held up for thirty seconds under-reports uptime by thirty seconds.
  const toleranceSeconds = Math.max(2 * f.heartbeatSeconds, 60);

  if (f.bootedAtBefore !== null && f.bootedAtAfter !== null) {
    const moved = Math.abs(f.bootedAtAfter.getTime() - f.bootedAtBefore.getTime()) / 1000;
    return moved > toleranceSeconds;
  }

  if (f.uptimeBefore === null || f.uptimeAfter === null) return false;
  // Uptime cannot run backwards without pid 1 having restarted. This half is
  // unambiguous; the drift test below is what catches the case it misses — a
  // box up five minutes that rebooted and came back up six.
  if (f.uptimeAfter < f.uptimeBefore) return true;
  const expected = f.uptimeBefore + f.durationSeconds;
  return expected - f.uptimeAfter > toleranceSeconds;
}
