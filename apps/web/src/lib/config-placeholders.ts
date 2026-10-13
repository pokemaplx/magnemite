/**
 * What a device group's MITM config template may substitute.
 *
 * A plain array with no imports, deliberately. The dashboard needs this list in
 * two places that cannot share a dependency: a server action, to refuse an
 * unknown placeholder at Save, and a client component, to show the help text
 * under the field. `@magnemite/protocol` holds the same list, but importing it
 * here drags every zod schema in the wire protocol along with it, and
 * `@magnemite/db` drags Prisma — neither belongs in a browser bundle.
 *
 * The authority at runtime is the hub's `PLACEHOLDERS` map in
 * `apps/hub/src/services/deviceConfig.ts`, which is what actually renders a
 * config and refuses an unknown name. This list only decides what the dashboard
 * accepts and advertises: if the two ever drift, a template saves here and is
 * refused there, which is visible rather than silent. Keep them in step.
 */
export const CONFIG_PLACEHOLDERS = [
  "device.id",
  "device.name",
  "device.serial",
  "device.model",
  "device.manufacturer",
  "device.androidVersion",
  "device.abi",
  "device.localIp",
  "device.publicIp",
  "device.rotomOrigin",
  "device.rotomDeviceId",
  // Off the box's Redroid instance row, so a machine's capacity is a number
  // the dashboard owns rather than one hard-coded per group. Refused at render
  // on a box that is not a container, which is the same refusal every other
  // placeholder with no value gets.
  "device.workers",
  "group.name",
] as const;

/**
 * One regex, matching anything between the braces and judging it by name
 * afterwards.
 *
 * Scanning for `[a-zA-Z0-9_.]` and substituting `[^}]*` was two different
 * ideas of what a placeholder is, and a token with a character in neither —
 * `{{device-name}}` — fell through both: never reported as unknown, never
 * matched by the hub, and written to every box in the group verbatim. The
 * hub's `TOKEN` is this same shape.
 */
const TEMPLATE_TOKEN = /\{\{([^{}]*)\}\}/g;

/**
 * Is this a config template the hub will be able to render?
 *
 * Here rather than beside one of its callers because there are two of them now
 * — a group's config and a rollout's override — and a validator that lives
 * with one of them is a validator the other one drifts from. Both have to
 * answer the same question, since both end up in `renderConfig`.
 *
 * Returns the reason it is not, or null.
 */
export function checkConfigTemplate(template: string): string | null {
  const known: readonly string[] = CONFIG_PLACEHOLDERS;
  const unknown = [...template.matchAll(TEMPLATE_TOKEN)]
    .map((match) => (match[1] as string).trim())
    .filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    return `Unknown placeholder ${[...new Set(unknown)].map((n) => `{{${n}}}`).join(", ")}. Known: ${CONFIG_PLACEHOLDERS.join(", ")}.`;
  }

  // A placeholder always stands in for a JSON string, and the hub escapes what
  // it substitutes so it stays one. Checking with a quoted stand-in is what
  // makes that the rule rather than an accident: `"workers": {{device.name}}`
  // is refused here, which is what lets the hub escape without having to ask
  // whether the token sat inside quotes.
  try {
    JSON.parse(template.replace(TEMPLATE_TOKEN, "PLACEHOLDER"));
  } catch (err) {
    return `The config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}
