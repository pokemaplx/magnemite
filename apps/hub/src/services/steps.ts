/**
 * The progress lines every provisioning script in this repo prints.
 *
 * Pure, and in their own module for that reason: `stepWriter.ts` next door
 * touches the database and the logger, and importing it would drag `env.js`
 * -- which exits a process whose environment is not a hub's -- into anything
 * that only wanted to parse a line, tests included.
 *
 * Shared by the machine bootstrap and the adb box enrollment. Deliberately
 * one copy: the `warn is not a failure` rule below is the kind of thing that
 * gets fixed in one place and not the other.
 */

export type BootstrapStep = { name: string; ok: boolean; detail: string };

/**
 * `::step <name> <ok|warn|fail> [detail]`.
 *
 * The scripts print these so a run that fails on the fourth stage can say
 * which, rather than just failing. Anything else on stdout is ignored -- apt,
 * docker and adb are all noisy and none of it is structured.
 */
export function parseStep(line: string): BootstrapStep | null {
  const match = /^::step\s+(\S+)\s+(ok|warn|fail)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return {
    // A warning is not a failure: swap that could not be created leaves a
    // machine that runs, and calling it a failure would stop a provisioning
    // that was going to work.
    name: match[1]!,
    ok: match[2] !== "fail",
    detail: (match[3] ?? "").trim(),
  };
}

/**
 * `::fact <address> <key> <value...>`.
 *
 * What the adb probe reports about a box it found. Fixed leading fields and a
 * free-text tail, exactly like `::step`, because `ro.product.model` is
 * routinely "Chromecast with Google TV" and `key=value` pairs would break on
 * the spaces. An address of `-` means the fact is about the run itself.
 */
export type BoxFact = { address: string; key: string; value: string };

export function parseFact(line: string): BoxFact | null {
  const match = /^::fact\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return { address: match[1]!, key: match[2]!, value: (match[3] ?? "").trim() };
}
