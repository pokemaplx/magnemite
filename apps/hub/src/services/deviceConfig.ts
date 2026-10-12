import {
  CAPABILITY_WRITE_CONFIG,
  CONFIG_PLACEHOLDERS,
  type ConfigPlaceholder,
  type DeviceConfigFile,
} from "@magnemite/protocol";

/**
 * The MITM's own settings file, written onto a box when its MITM is installed.
 *
 * The template lives on the group because the config does: two sites talking to
 * two Rotom instances are two groups, and a config that could only be set once
 * could not describe them both. What differs per box — the name it reports —
 * comes from placeholders, which is the same job aconf does with
 * `sed 's,dummy,$origin,g'`.
 *
 * Nothing here ever logs `content`. An aegis config holds `authBearer`,
 * `deviceAuthToken` and an email address, and this file is the one place that
 * handles all of them.
 */

/**
 * How to read each placeholder. The names come from the protocol package, which
 * the dashboard validates against too — typed as a total map, so adding a name
 * there and forgetting to read it here is a type error rather than a config
 * that saves and then refuses to push.
 */
const PLACEHOLDERS: Record<ConfigPlaceholder, (d: DeviceForConfig) => string | null> = {
  "device.id": (d: DeviceForConfig) => d.id,
  "device.name": (d: DeviceForConfig) => d.name,
  "device.serial": (d: DeviceForConfig) => d.serial,
  "device.model": (d: DeviceForConfig) => d.model,
  "device.manufacturer": (d: DeviceForConfig) => d.manufacturer,
  "device.androidVersion": (d: DeviceForConfig) => d.androidVersion,
  "device.abi": (d: DeviceForConfig) => d.abi,
  "device.localIp": (d: DeviceForConfig) => d.localIp,
  "device.publicIp": (d: DeviceForConfig) => d.publicIp,
  "device.rotomOrigin": (d: DeviceForConfig) => d.rotomOrigin,
  "device.rotomDeviceId": (d: DeviceForConfig) => d.rotomDeviceId,
  // How many workers this box is configured for, off its Redroid instance row.
  //
  // The whole point of Magnemite owning that number: a machine's capacity is
  // containers times workers, and without this the figure the scale form
  // collects would be decorative -- the operator would still be hard-coding
  // `"workers": 50` into the group's config, where it is the same for every
  // machine in the group.
  //
  // Null on a box that is not a container, which the renderer refuses rather
  // than substituting as empty. That refusal is the feature: a scanner started
  // against `"workers": ""` is worse off than one never configured, and a
  // group mixing containers with real hardware finds out at the deploy that
  // names the box, instead of silently.
  "device.workers": (d: DeviceForConfig) =>
    d.redroidInstance?.workers == null ? null : String(d.redroidInstance.workers),
  "group.name": (d: DeviceForConfig) => d.group?.name ?? null,
};

/**
 * Deliberately permissive about what sits between the braces, and strict about
 * the name only afterwards.
 *
 * A regex that matched `[a-zA-Z0-9_.]` only did not match `{{device-name}}` at
 * all, so a typo was neither substituted nor reported as unknown: it was
 * written to every box in the group verbatim, and the whole site registered
 * with Rotom under the literal string `{{device-name}}`. Matching anything and
 * rejecting it by name is what turns that into a refusal.
 */
const TOKEN = /\{\{([^{}]*)\}\}/g;

export type DeviceForConfig = {
  id: string;
  name: string;
  serial: string;
  model: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  abi: string | null;
  localIp: string | null;
  publicIp: string | null;
  rotomOrigin: string | null;
  rotomDeviceId: string | null;
  redroidInstance: { workers: number | null } | null;
  group: {
    name: string;
    mitmPackageName: string | null;
    mitmConfigPath: string | null;
    mitmConfig: string | null;
  } | null;
};

/** What to select to get a `DeviceForConfig` out of Prisma. */
export const deviceForConfigSelect = {
  id: true,
  name: true,
  serial: true,
  model: true,
  manufacturer: true,
  androidVersion: true,
  abi: true,
  localIp: true,
  publicIp: true,
  rotomOrigin: true,
  rotomDeviceId: true,
  redroidInstance: { select: { workers: true } },
  group: {
    select: {
      name: true,
      mitmPackageName: true,
      mitmConfigPath: true,
      mitmConfig: true,
    },
  },
} as const;

export type RenderedConfig = DeviceConfigFile;
export type RenderOutcome =
  | { ok: true; file: RenderedConfig }
  | { ok: false; reason: string }
  // The group declares no config at all. Silence, not a problem to report.
  | null;

/**
 * Substitute a template for one box.
 *
 * Both failure modes are refusals rather than best-effort substitutions:
 *
 * - An unknown placeholder would otherwise be written through literally, and a
 *   scanner started against `"deviceName": "{{device.nmae}}"` is worse off than
 *   one never configured.
 * - A known placeholder with no value would be substituted with an empty
 *   string, which is how a whole site ends up reporting to Rotom under the same
 *   blank origin. `rotomOrigin` is null until the Rotom sync matches a box, so
 *   this fires often on a fresh fleet — saying which box and which field is
 *   what keeps that from reading as broken.
 *
 * The value is JSON-escaped on the way in. A config is JSON — the dashboard
 * refuses to save a template that is not — and every placeholder it can save
 * therefore sits inside a string literal, while the values are free-form
 * operator text: a box renamed `Kitchen "spare"` would otherwise render a file
 * that does not parse, and one named `x", "rotomUrl": "http://elsewhere` would
 * render a file that parses and points the scanner somewhere else.
 */
export function renderTemplate(
  template: string,
  device: DeviceForConfig,
): { ok: true; text: string } | { ok: false; reason: string } {
  const unknown: string[] = [];
  const empty: string[] = [];

  const text = template.replace(TOKEN, (whole, raw: string) => {
    const name = raw.trim();
    // `Object.hasOwn`, not a truthy lookup: a bare index finds `constructor`
    // and `toString` on Object.prototype, which rendered `[object Object]`
    // into the file, and `{{hasOwnProperty}}` threw out of the scheduler tick.
    if (!Object.hasOwn(PLACEHOLDERS, name)) {
      unknown.push(name);
      return whole;
    }
    const value = PLACEHOLDERS[name as ConfigPlaceholder](device);
    if (value === null || value === "") {
      empty.push(name);
      return whole;
    }
    return escapeForJsonString(value);
  });

  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `unknown placeholder ${unknown.map((n) => `{{${n}}}`).join(", ")} — ` +
        `known ones are ${CONFIG_PLACEHOLDERS.join(", ")}`,
    };
  }
  if (empty.length > 0) {
    return {
      ok: false,
      reason: `${empty.map((n) => `{{${n}}}`).join(", ")} is empty on ${device.name}`,
    };
  }
  return { ok: true, text };
}

/**
 * The body of a JSON string literal, without the quotes around it.
 *
 * `JSON.stringify` is what knows the whole rule — the quote, the backslash, the
 * newline a pasted name can carry, and the control characters that are not
 * legal in a JSON string at all.
 */
function escapeForJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Pure, so the scheduler can use the device it has already loaded. */
export function renderConfig(device: DeviceForConfig): RenderOutcome {
  const group = device.group;
  if (!group?.mitmConfigPath || !group.mitmConfig) return null;

  const rendered = renderTemplate(group.mitmConfig, device);
  if (!rendered.ok) return rendered;

  // The template was checked at save and the values are escaped above, so this
  // should not fire. It is here for the templates that never went through the
  // form — a seed, a psql edit, a restored backup — which would otherwise ship
  // a file the scanner cannot read and be reported as written.
  try {
    JSON.parse(rendered.text);
  } catch (err) {
    return {
      ok: false,
      reason: `the rendered config is not valid JSON on ${device.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return {
    ok: true,
    file: {
      path: group.mitmConfigPath,
      content: rendered.text,
      mode: "0644",
    },
  };
}

/**
 * Whether a box's agent claims it can write a config file at all.
 *
 * Deliberately not derived from `agentVersion`: version arithmetic reads a
 * backported build as too old, and what that costs is a config attached to an
 * install that the box then ignores.
 */
export function hasWriteConfig(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(CAPABILITY_WRITE_CONFIG);
}
