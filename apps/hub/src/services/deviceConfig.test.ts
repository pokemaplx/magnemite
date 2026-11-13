import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DeviceForConfig,
  configFormat,
  renderConfig,
  renderTemplate,
  tomlContextAt,
  usesPlaceholder,
} from "./deviceConfig.js";

const FLEET = { workersPerInstance: 50 };

function box(redroidInstance: DeviceForConfig["redroidInstance"]): DeviceForConfig {
  return {
    id: "dev1",
    name: "hel-01-1",
    serial: "rd-abcdef-01",
    model: null,
    manufacturer: null,
    androidVersion: null,
    abi: null,
    localIp: null,
    publicIp: null,
    rotomOrigin: null,
    rotomDeviceId: null,
    redroidInstance,
    group: null,
  };
}

const TEMPLATE = '{"workers": "{{device.workers}}"}';

// ---------------------------------------------------------------------------
// {{device.workers}}, resolved at the render
// ---------------------------------------------------------------------------

test("a container on nobody's number renders the fleet's", () => {
  const out = renderTemplate(TEMPLATE, box({ workers: null, host: { workers: null } }), FLEET);
  assert.deepEqual(out, { ok: true, text: '{"workers": "50"}' });
});

test("a machine's own number beats the fleet's", () => {
  const out = renderTemplate(TEMPLATE, box({ workers: null, host: { workers: 30 } }), FLEET);
  assert.deepEqual(out, { ok: true, text: '{"workers": "30"}' });
});

test("a container's own number beats its machine's", () => {
  const out = renderTemplate(TEMPLATE, box({ workers: 25, host: { workers: 30 } }), FLEET);
  assert.deepEqual(out, { ok: true, text: '{"workers": "25"}' });
});

test("a changed setting reaches a container that follows it, with nothing re-saved", () => {
  // The whole point of resolving at the render: nothing was copied anywhere,
  // so the same rows render the new number.
  const device = box({ workers: null, host: { workers: null } });
  assert.deepEqual(renderTemplate(TEMPLATE, device, { workersPerInstance: 40 }), {
    ok: true,
    text: '{"workers": "40"}',
  });
});

test("a box that is not a container is refused, not given the fleet's number", () => {
  // Hardware has no worker count, and a scanner started against one it was
  // never configured for is worse off than a refusal naming the box.
  const out = renderTemplate(TEMPLATE, box(null), FLEET);
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.reason, /device\.workers.*hel-01-1/);
});

// ---------------------------------------------------------------------------
// Whether a template says workers at all
// ---------------------------------------------------------------------------

test("a template that names the placeholder uses it", () => {
  assert.equal(usesPlaceholder(TEMPLATE, "device.workers"), true);
});

test("spaces inside the braces count, because they render", () => {
  assert.equal(usesPlaceholder('{"w": "{{ device.workers }}"}', "device.workers"), true);
});

test("a template that does not name it does not use it", () => {
  assert.equal(usesPlaceholder('{"name": "{{device.name}}"}', "device.workers"), false);
});

test("a name that only starts the same is a different placeholder", () => {
  assert.equal(usesPlaceholder('{"w": "{{device.workersMax}}"}', "device.workers"), false);
});

test("asking twice gives the same answer", () => {
  // The token regex is global, and a global regex carries `lastIndex` between
  // calls -- the bug that makes every second answer wrong.
  assert.equal(usesPlaceholder(TEMPLATE, "device.workers"), true);
  assert.equal(usesPlaceholder(TEMPLATE, "device.workers"), true);
});

test("a toml config renders without json validation error", () => {
  const d: DeviceForConfig = {
    ...box(null),
    group: {
      name: "Lunala Group",
      mitmPackageName: "lunala",
      mitmConfigPath: "/app/config.toml",
      mitmConfig: '[general]\ndevice_name = "{{device.name}}"\nworkers = 1\n',
    },
  };
  const out = renderConfig(d, FLEET);
  assert.ok(out && out.ok);
  assert.equal(out.file.path, "/app/config.toml");
  assert.equal(out.file.content, '[general]\ndevice_name = "hel-01-1"\nworkers = 1\n');
});

// ---------------------------------------------------------------------------
// TOML: Cosmog's config, the shape aconf ships as cosmog_config.toml
// ---------------------------------------------------------------------------

const COSMOG = `[rotom]
rotom_worker_endpoint = "ws://rotom.lan:7070/"
rotom_secret = "s3cret" # not {{device.name}}'s business

[general]
device_name = "{{device.name}}"
workers = {{device.workers}}
klefki_token = 'tok'
`;

function cosmogBox(name: string, template = COSMOG): DeviceForConfig {
  return {
    ...box({ workers: 25, host: { workers: null } }),
    name,
    group: {
      name: "Cosmog",
      mitmPackageName: "com.sy1vi3.cosmog",
      mitmConfigPath: "/data/local/tmp/cos/config.toml",
      mitmConfig: template,
    },
  };
}

test("the format is the path's to say", () => {
  assert.equal(configFormat("/data/local/tmp/cos/config.toml"), "toml");
  assert.equal(configFormat("/data/local/tmp/aegis_config.json"), "json");
  assert.equal(configFormat("/data/local/tmp/config"), "json");
});

test("a cosmog config renders, with workers as an integer", () => {
  const out = renderConfig(cosmogBox("atv-07"), FLEET);
  assert.ok(out && out.ok);
  assert.equal(out.file.path, "/data/local/tmp/cos/config.toml");
  assert.match(out.file.content, /^device_name = "atv-07"$/m);
  // Not `"25"`: Cosmog reads an integer, and a string there is a config that
  // does not load.
  assert.match(out.file.content, /^workers = 25$/m);
  assert.match(out.file.content, /# not atv-07's business$/m);
});

test("a quote in a name stays inside its toml string", () => {
  const out = renderConfig(cosmogBox('x"\nrotom_secret = "elsewhere'), FLEET);
  assert.ok(out && out.ok);
  assert.match(out.file.content, /^device_name = "x\\"\\nrotom_secret = \\"elsewhere"$/m);
  // One rotom_secret, the template's own.
  assert.equal(out.file.content.match(/^rotom_secret/gm)?.length, 1);
});

test("outside quotes only a number may be written", () => {
  const out = renderConfig(
    cosmogBox("atv-07", "[general]\ndevice_name = {{device.name}}\n"),
    FLEET,
  );
  assert.ok(out && !out.ok);
  assert.match(out.reason, /device\.name.*atv-07/);
});

test("a literal string refuses the quote it cannot escape", () => {
  const template = "[general]\ndevice_name = '{{device.name}}'\n";
  const fine = renderConfig(cosmogBox("atv-07", template), FLEET);
  assert.ok(fine && fine.ok);
  assert.equal(fine.file.content, "[general]\ndevice_name = 'atv-07'\n");
  const bad = renderConfig(cosmogBox("o'brien", template), FLEET);
  assert.ok(bad && !bad.ok);
});

test("a toml box that is not a container is still refused its workers", () => {
  const device = { ...cosmogBox("atv-07"), redroidInstance: null };
  const out = renderConfig(device, FLEET);
  assert.ok(out && !out.ok);
  assert.match(out.reason, /device\.workers.*atv-07/);
});

test("toml context follows quotes and comments", () => {
  const text = `a = "x # y" # c\nb = 'z' \nc = """m\nn""" d`;
  const at = (needle: string) => tomlContextAt(text, text.indexOf(needle));
  assert.equal(at("x #"), "basic");
  assert.equal(at('y"'), "basic");
  assert.equal(at("c\n"), "comment");
  assert.equal(at("z"), "literal");
  assert.equal(at('n"""'), "basic");
  assert.equal(at(" d"), "bare");
});
