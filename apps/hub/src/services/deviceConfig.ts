import {
  CAPABILITY_WRITE_CONFIG,
  CONFIG_PLACEHOLDERS,
  type ConfigPlaceholder,
  type DeviceConfigFile,
} from "@magnemite/protocol";
import { type RedroidSettingsValues, resolveWorkers } from "@magnemite/db";

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
const PLACEHOLDERS: Record<
  ConfigPlaceholder,
  (d: DeviceForConfig, defaults: ConfigDefaults) => string | null
> = {
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
  // How many workers this box is configured for: its instance's own number,
  // else its machine's, else Settings. Resolved here, at the render, so a
  // changed setting reaches the next config written rather than waiting for
  // somebody to Save every machine again.
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
  "device.workers": (d: DeviceForConfig, defaults: ConfigDefaults) =>
    d.redroidInstance
      ? String(resolveWorkers(d.redroidInstance.workers, d.redroidInstance.host.workers, defaults))
      : null,
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
  redroidInstance: { workers: number | null; host: { workers: number | null } } | null;
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
  redroidInstance: { select: { workers: true, host: { select: { workers: true } } } },
  group: {
    select: {
      name: true,
      mitmPackageName: true,
      mitmConfigPath: true,
      mitmConfig: true,
    },
  },
} as const;

/**
 * What a render needs that is on no row of the device's own: the fleet-wide
 * end of an inheritance. `getRedroidSettings()` satisfies it as it is.
 */
export type ConfigDefaults = Pick<RedroidSettingsValues, "workersPerInstance">;

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
 * The value is JSON-escaped on the way in. A JSON config's placeholders all
 * sit inside string literals — the dashboard refuses to save one where they do
 * not — and a TOML one (Cosmog, Lunala) is escaped by where each placeholder
 * stands, see `encodeForToml`. Either way the values are free-form
 * operator text: a box renamed `Kitchen "spare"` would otherwise render a file
 * that does not parse, and one named `x", "rotomUrl": "http://elsewhere` would
 * render a file that parses and points the scanner somewhere else.
 */
export function renderTemplate(
  template: string,
  device: DeviceForConfig,
  defaults: ConfigDefaults,
  format: ConfigFormat = "json",
): { ok: true; text: string } | { ok: false; reason: string } {
  const unknown: string[] = [];
  const empty: string[] = [];
  const unsafe: string[] = [];

  const text = template.replace(TOKEN, (whole, raw: string, offset: number) => {
    const name = raw.trim();
    // `Object.hasOwn`, not a truthy lookup: a bare index finds `constructor`
    // and `toString` on Object.prototype, which rendered `[object Object]`
    // into the file, and `{{hasOwnProperty}}` threw out of the scheduler tick.
    if (!Object.hasOwn(PLACEHOLDERS, name)) {
      unknown.push(name);
      return whole;
    }
    const value = PLACEHOLDERS[name as ConfigPlaceholder](device, defaults);
    if (value === null || value === "") {
      empty.push(name);
      return whole;
    }
    if (format === "toml") {
      const encoded = encodeForToml(value, tomlContextAt(template, offset));
      if (encoded === null) {
        unsafe.push(name);
        return whole;
      }
      return encoded;
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
  if (unsafe.length > 0) {
    return {
      ok: false,
      reason:
        `${unsafe.map((n) => `{{${n}}}`).join(", ")} cannot be written where the TOML has it on ` +
        `${device.name} — outside quotes a value must be a number, and inside '…' it may not ` +
        `hold a quote. Put the placeholder inside "…"`,
    };
  }
  return { ok: true, text };
}

/**
 * Which file format a config path means.
 *
 * By the path and nothing else: it is what the scanner goes by too. Cosmog
 * reads `/data/local/tmp/cos/config.toml` as TOML whatever is in it, and
 * guessing from the contents is how a JSON typo becomes "must be TOML then".
 */
export type ConfigFormat = "json" | "toml";

export function configFormat(path: string | null | undefined): ConfigFormat {
  return path?.toLowerCase().endsWith(".toml") ? "toml" : "json";
}

/**
 * Where in a TOML document an offset sits.
 *
 * JSON never needed this: the dashboard only saves a template whose
 * placeholders are all inside string literals, so one escape fits every token.
 * TOML is typed, and Cosmog's `workers = 50` is an integer — written as
 * `workers = "50"` it does not parse as a config at all. So a placeholder may
 * stand outside quotes there, and how a value is written depends on which of
 * the four places it landed in.
 *
 * Not a TOML parser: it only follows quotes and comments, which is everything
 * that decides the escape. An unterminated single-line string ends at its
 * newline, as it would for the scanner reading the file.
 */
type TomlContext = "bare" | "basic" | "literal" | "comment";

export function tomlContextAt(text: string, offset: number): TomlContext {
  let state: TomlContext = "bare";
  let multiline = false;
  for (let i = 0; i < offset; i++) {
    const ch = text[i];
    if (state === "bare") {
      if (ch === "#") state = "comment";
      else if (ch === '"' || ch === "'") {
        state = ch === '"' ? "basic" : "literal";
        multiline = text.startsWith(ch.repeat(3), i);
        if (multiline) i += 2;
      }
    } else if (state === "comment") {
      if (ch === "\n") state = "bare";
    } else {
      const quote = state === "basic" ? '"' : "'";
      if (state === "basic" && ch === "\\") i++;
      else if (multiline ? text.startsWith(quote.repeat(3), i) : ch === quote) {
        if (multiline) i += 2;
        state = "bare";
        multiline = false;
      } else if (ch === "\n" && !multiline) state = "bare";
    }
  }
  return state;
}

/** What may stand outside quotes: a TOML integer, float or boolean. */
const TOML_BARE = /^(?:[+-]?\d+(?:\.\d+)?|true|false)$/;

/**
 * One value, written for the place it lands in. Null when it cannot be written
 * there without changing what the file means.
 *
 * - In `"…"` and in a comment: the JSON escape. Every sequence JSON.stringify
 *   emits is one TOML's basic string accepts, and none of them is a raw
 *   newline, so a comment stays one line.
 * - In `'…'`: nothing is escapable, so a value with a quote or a control
 *   character is refused.
 * - Outside quotes: a number or a boolean, or refused. A box named
 *   `8\nrotom_secret = "x"` must not be able to add a key.
 */
function encodeForToml(value: string, context: TomlContext): string | null {
  if (context === "basic" || context === "comment") return escapeForJsonString(value);
  if (context === "literal") return /['\u0000-\u001f\u007f]/.test(value) ? null : value;
  return TOML_BARE.test(value) ? value : null;
}

/**
 * Whether a template substitutes `name` anywhere.
 *
 * Read the way the renderer reads it -- any braces, the name trimmed -- so
 * `{{ device.workers }}` counts, exactly as it renders. What decides whether a
 * changed worker count is worth restarting a scanner for: a config that does
 * not say workers is the same file either way.
 */
export function usesPlaceholder(template: string, name: ConfigPlaceholder): boolean {
  for (const match of template.matchAll(TOKEN)) {
    if (match[1]?.trim() === name) return true;
  }
  return false;
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

/**
 * Pure, so the scheduler can use the device it has already loaded.
 *
 * `override` is one rollout's config standing in for the group's, the same way
 * that rollout's hooks stand in for the group's. Only the body: the path is
 * still the group's, because that is where the scanner reads it, and a box
 * whose group has no path therefore takes no config either way.
 */
export function renderConfig(
  device: DeviceForConfig,
  defaults: ConfigDefaults,
  override?: string | null,
): RenderOutcome {
  const group = device.group;
  const template = override ?? group?.mitmConfig;
  if (!group?.mitmConfigPath || !template) return null;

  const format = configFormat(group.mitmConfigPath);
  const rendered = renderTemplate(template, device, defaults, format);
  if (!rendered.ok) return rendered;

  // The template was checked at save and the values are escaped above, so this
  // should not fire. It is here for the templates that never went through the
  // form — a seed, a psql edit, a restored backup — which would otherwise ship
  // a file the scanner cannot read and be reported as written.
  if (format === "json") {
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
