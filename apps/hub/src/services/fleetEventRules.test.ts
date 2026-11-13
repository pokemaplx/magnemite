import assert from "node:assert/strict";
import { test } from "node:test";
import { JOIN_ROLLOUT_NOTE, type JobState } from "@magnemite/db";
import {
  type SourceState,
  newestIfNews,
  nextSourceState,
  settledEvent,
  startedEvent,
} from "./fleetEventRules.js";

const jobs = (...states: JobState[]) => states.map((state) => ({ state }));

test("a rollout started by an operator and one started by auto-update are different events", () => {
  assert.equal(
    startedEvent({ mode: "MANUAL", note: null, jobs: jobs("QUEUED") }),
    "rolloutStarted",
  );
  assert.equal(
    startedEvent({ mode: "AUTO", note: "auto-update to 1.2 (mirror)", jobs: jobs("QUEUED") }),
    "rolloutAutoStarted",
  );
});

test("a join install starts in silence", () => {
  assert.equal(
    startedEvent({ mode: "MANUAL", note: JOIN_ROLLOUT_NOTE, jobs: jobs("QUEUED") }),
    null,
  );
});

test("a rollout with nothing to install is not announced as started", () => {
  assert.equal(startedEvent({ mode: "AUTO", note: null, jobs: jobs("SKIPPED", "SKIPPED") }), null);
  assert.equal(
    startedEvent({ mode: "MANUAL", note: null, jobs: jobs("SKIPPED", "QUEUED") }),
    "rolloutStarted",
  );
});

test("one failed job makes a finished rollout a failure", () => {
  assert.equal(settledEvent({ note: null, jobs: jobs("SUCCESS", "SKIPPED") }), "rolloutSucceeded");
  assert.equal(settledEvent({ note: null, jobs: jobs("SUCCESS", "FAILED") }), "rolloutFailed");
  assert.equal(settledEvent({ note: null, jobs: jobs("FAILED") }), "rolloutFailed");
});

test("a rollout that installed nothing and failed nothing says nothing when it finishes", () => {
  assert.equal(settledEvent({ note: null, jobs: jobs("SKIPPED", "CANCELLED") }), null);
  assert.equal(settledEvent({ note: null, jobs: [] }), null);
});

test("a join install is only announced when it fails", () => {
  assert.equal(settledEvent({ note: JOIN_ROLLOUT_NOTE, jobs: jobs("SUCCESS") }), null);
  assert.equal(
    settledEvent({ note: JOIN_ROLLOUT_NOTE, jobs: jobs("FAILED") }),
    "joinInstallFailed",
  );
});

test("the newest new build is news only when it is newer than everything already known", () => {
  assert.equal(newestIfNews(["0.351.0"], ["0.349.1", "0.350.2"]), "0.351.0");
  assert.equal(newestIfNews(["0.350.0", "0.351.0", "0.349.0"], []), "0.351.0");
  assert.equal(newestIfNews([], ["0.350.0"]), null);
});

test("a source added today does not announce the builds it lists from the past", () => {
  assert.equal(newestIfNews(["0.340.0", "0.345.1", "0.349.0"], ["0.350.2"]), null);
  // The same version in another architecture is not a new release either.
  assert.equal(newestIfNews(["0.350.2"], ["0.350.2"]), null);
});

test("a source is announced once per outage, after two failed passes, then cleared once", () => {
  let state: SourceState | undefined;
  const pass = (ok: boolean) => {
    const next = nextSourceState(state, ok);
    state = next.state;
    return next.say;
  };

  assert.equal(pass(false), null);
  assert.equal(pass(false), "failing");
  assert.equal(pass(false), null);
  assert.equal(pass(false), null);
  assert.equal(pass(true), "recovered");
  assert.equal(pass(true), null);
});

test("one bad pass recovers in silence", () => {
  let state: SourceState | undefined;
  state = nextSourceState(state, false).state;
  const next = nextSourceState(state, true);
  assert.equal(next.say, null);
  assert.deepEqual(next.state, { streak: 0, announced: false });
});
