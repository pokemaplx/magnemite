import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeviceForConfig, renderTemplate, usesPlaceholder } from "./deviceConfig.js";

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
