import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, rebooted, type ConnectionFacts } from "./connectivityCause.js";

/**
 * A box that was simply gone and came back with nothing else to say.
 *
 * Every case below starts here and changes the one fact it is about, so a test
 * names its own evidence rather than restating eleven fields.
 */
const base: ConnectionFacts = {
  hubRestarted: false,
  closeCode: 1006,
  wasTerminated: false,
  durationSeconds: 120,
  heartbeatSeconds: 20,
  uptimeBefore: 3600,
  // Nothing restarted: uptime kept climbing across the gap.
  uptimeAfter: 3720,
  bootedAtBefore: null,
  bootedAtAfter: null,
  agentStartedBefore: null,
  agentStartedAfter: null,
};

const facts = (over: Partial<ConnectionFacts>): ConnectionFacts => ({ ...base, ...over });

test("a socket that never closed is a stall, not a disconnection", () => {
  // The whole point of the signal: the box was reachable the entire time, so
  // this must never read as unreachable.
  assert.equal(classify(facts({ closeCode: null })), "HEARTBEAT_STALL");
});

test("the hub hanging up is named rather than left as a bare 1006", () => {
  assert.equal(classify(facts({ wasTerminated: true })), "TERMINATED_BY_HUB");
});

test("a close with nothing restarted is a lost link", () => {
  assert.equal(classify(base), "LINK_LOST");
});

test("the hub's own downtime outranks everything, because it is not about the box", () => {
  // Even with a boot that moved and a socket that never closed, a gap the hub
  // was absent for is evidence of nothing.
  assert.equal(
    classify(
      facts({
        hubRestarted: true,
        closeCode: null,
        uptimeAfter: 5,
      }),
    ),
    "HUB_RESTART",
  );
});

test("the hub's own close codes outrank what the box says about its boot", () => {
  assert.equal(classify(facts({ closeCode: 4004, uptimeAfter: 5 })), "DEVICE_DELETED");
  assert.equal(classify(facts({ closeCode: 4000, uptimeAfter: 5 })), "REPLACED");
});

test("uptime running backwards is a reboot, with no tolerance to argue about", () => {
  assert.equal(classify(facts({ uptimeBefore: 3600, uptimeAfter: 5 })), "REBOOT");
});

test("a box up briefly that rebooted is caught by the drift, not by the ordering", () => {
  // The case `uptimeAfter < uptimeBefore` cannot see: up only 30s, away 120s,
  // rebooted an hour into the gap and back up 60s. The new uptime is *higher*
  // than the old one, so the ordering test passes it — and an unbroken box
  // would have come back at ~150s, which is what gives it away.
  assert.equal(
    classify(facts({ durationSeconds: 120, uptimeBefore: 30, uptimeAfter: 60 })),
    "REBOOT",
  );
});

test("a box that stayed up longer than the gap did not reboot during it", () => {
  // The boundary the case above sits next to, and the reason it is not just
  // "uptime drifted": coming back with more uptime than the gap lasted is
  // proof the box was there the whole time, whatever the arithmetic says.
  assert.equal(
    classify(facts({ durationSeconds: 120, uptimeBefore: 300, uptimeAfter: 360 })),
    "LINK_LOST",
  );
});

test("a slow beat under-reporting uptime is not mistaken for a reboot", () => {
  // The last beat was generated 30s before it was sent, so uptime lands 30s
  // short of the arithmetic. Inside the tolerance, so nothing rebooted.
  assert.equal(
    classify(facts({ durationSeconds: 120, uptimeBefore: 3600, uptimeAfter: 3690 })),
    "LINK_LOST",
  );
});

test("the tolerance follows the heartbeat rather than a constant", () => {
  // 45s of drift: inside a 300s beat's tolerance, outside nothing's. The
  // floor of 60s is what keeps a fast heartbeat from being twitchy.
  const drifting = { durationSeconds: 120, uptimeBefore: 3600, uptimeAfter: 3675 };
  assert.equal(rebooted(facts({ ...drifting, heartbeatSeconds: 300 })), false);
  assert.equal(rebooted(facts({ ...drifting, heartbeatSeconds: 20 })), false, "60s floor applies");
  assert.equal(
    rebooted(
      facts({ durationSeconds: 120, uptimeBefore: 3600, uptimeAfter: 3600, heartbeatSeconds: 20 }),
    ),
    true,
    "120s of drift is past the floor",
  );
});

test("a boot instant that moved beats the uptime arithmetic", () => {
  const now = Date.now();
  // Uptime says nothing restarted; the boot instant says otherwise, and it is
  // the one that is not distorted by a slow beat.
  assert.equal(
    classify(
      facts({
        bootedAtBefore: new Date(now - 3_600_000),
        bootedAtAfter: new Date(now - 10_000),
      }),
    ),
    "REBOOT",
  );
});

test("a boot instant that held is trusted over uptime that drifted", () => {
  const bootedAt = new Date(Date.now() - 3_600_000);
  assert.equal(
    classify(
      facts({
        bootedAtBefore: bootedAt,
        bootedAtAfter: bootedAt,
        // Drift that would read as a reboot on its own.
        uptimeBefore: 3600,
        uptimeAfter: 3600,
      }),
    ),
    "LINK_LOST",
  );
});

test("an NTP nudge to the boot instant is not a reboot", () => {
  const now = Date.now();
  assert.equal(
    rebooted(
      facts({
        bootedAtBefore: new Date(now - 3_600_000),
        bootedAtAfter: new Date(now - 3_600_000 + 30_000),
      }),
    ),
    false,
  );
});

test("a new agent process on the same boot is a restart, not a reboot", () => {
  const bootedAt = new Date(Date.now() - 3_600_000);
  assert.equal(
    classify(
      facts({
        bootedAtBefore: bootedAt,
        bootedAtAfter: bootedAt,
        agentStartedBefore: new Date(Date.now() - 3_000_000),
        agentStartedAfter: new Date(Date.now() - 10_000),
      }),
    ),
    "AGENT_RESTART",
  );
});

test("an agent too old to report its boot still classifies, through uptime", () => {
  // The compatibility promise: absence is the signal, and an old box falls
  // back rather than failing or being guessed at.
  assert.equal(
    classify(facts({ bootedAtBefore: null, bootedAtAfter: null, uptimeAfter: 5 })),
    "REBOOT",
  );
});

test("an agent that says nothing at all is never guessed into a reboot", () => {
  assert.equal(
    rebooted(facts({ uptimeBefore: null, uptimeAfter: null })),
    false,
    "unknown must not read as a fault",
  );
  assert.equal(rebooted(facts({ uptimeBefore: 3600, uptimeAfter: null })), false);
});
