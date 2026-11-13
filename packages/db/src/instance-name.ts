/**
 * What a machine's containers are called when they enrol.
 *
 * Its own module, and imported from `@magnemite/db/instance-name` rather than
 * from the package root, because the dashboard renders a live preview of a
 * template as it is typed — and that is a client component. The root entry
 * opens a `PrismaClient` at import time, so reaching for it from the browser
 * would pull the whole database layer into the bundle. Nothing here imports
 * anything.
 */

/**
 * Without a template a Redroid box names itself from what Android reports,
 * which is `redroid redroid12_arm64_only 7es-01` — the manufacturer, the model
 * and six characters of a minted serial. Every box on every machine gets the
 * same two useless words and differs only in the tail, which is the opposite
 * of what a fleet list is for.
 */
export const DEFAULT_INSTANCE_NAME_TEMPLATE = "{host}-{index}";

/** The placeholders a template understands, for the UI to list. */
export const INSTANCE_NAME_PLACEHOLDERS = ["host", "index", "serial"] as const;

/**
 * Fills a template in.
 *
 * `{index}` is padded to two digits, matching the serial and the compose
 * service name (`box-01`), because that is what sorts correctly in a list of
 * more than nine.
 *
 * An unknown placeholder is left exactly as it was written rather than
 * replaced with nothing: `{hsot}-01` is a visible typo, and `-01` is a
 * mystery. The result is capped at what a device name is allowed to be, which
 * is also the length the column takes on the narrower of the two providers.
 *
 * Applied **only when the Device row is created**. A re-enrolment keeps the
 * name the row already has, so a box renamed by hand stays renamed and a
 * template changed later does not go back and rewrite history.
 */
export function renderInstanceName(
  template: string,
  parts: { host: string; index: number; serial: string },
): string {
  const padded = String(parts.index).padStart(2, "0");
  return template
    .replace(/\{(host|index|serial)\}/g, (_match, key: string) =>
      key === "host" ? parts.host : key === "index" ? padded : parts.serial,
    )
    .trim()
    .slice(0, 64);
}
