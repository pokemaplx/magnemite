/**
 * Getting a script's progress onto a row without fighting the database.
 *
 * Shared by the machine bootstrap (`hostBootstrap.ts`) and the adb box
 * enrollment (`boxEnroll.ts`). Deliberately not copied into the second one:
 * the trap below is not obvious, and a copy would carry the bug back the
 * first time somebody edited only one of them.
 *
 * Parsing the lines lives in `steps.ts`, which is pure. This half is not: it
 * writes and it logs.
 */

import { log } from "../log.js";
import type { BootstrapStep } from "./steps.js";

// Re-exported so callers have one import site for "the step protocol",
// whether they parse lines, write them, or both.
export { parseFact, parseStep } from "./steps.js";
export type { BootstrapStep, BoxFact } from "./steps.js";

/**
 * Writes a step list to a row, one write at a time, latest wins.
 *
 * An earlier version fired an un-awaited `update` on every `::step` line,
 * which looked harmless and was not: a script prints several steps within
 * milliseconds of each other, so the updates overlapped on one row and
 * MariaDB rejected them with error 1020, "Record has changed since last
 * read". Progress stopped being written for the rest of the run.
 *
 * So: at most one write in flight, and a burst collapses into the newest
 * state rather than queueing a write per line. Nobody needs every
 * intermediate list -- they need the latest one to arrive.
 *
 * The array is copied on the way in, because the caller keeps pushing to its
 * own and a reference would be serialised at whatever length it happened to
 * have when the query ran.
 */
export function stepWriter(
  save: (steps: BootstrapStep[]) => Promise<unknown>,
  context: Record<string, unknown>,
) {
  let inFlight: Promise<void> | null = null;
  let pending: BootstrapStep[] | null = null;

  const write = async (steps: BootstrapStep[]): Promise<void> => {
    try {
      await save(steps);
    } catch (err) {
      // Progress is nice to have; the run is not. The same trade recordSample
      // makes -- losing a line of progress must never fail a provisioning
      // that is otherwise working.
      log.warn({ err, ...context }, "could not write progress");
    }
    if (pending) {
      const next = pending;
      pending = null;
      await write(next);
    }
  };

  const publish = (steps: BootstrapStep[]): void => {
    const snapshot = [...steps];
    if (inFlight) {
      pending = snapshot;
      return;
    }
    inFlight = write(snapshot).finally(() => {
      inFlight = null;
    });
  };

  /** Awaits whatever is still queued, so the final state is on the row. */
  publish.flush = async (): Promise<void> => {
    while (inFlight) await inFlight;
  };

  return publish;
}
