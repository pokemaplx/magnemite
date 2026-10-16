import assert from "node:assert/strict";
import { test } from "node:test";
import { expandAddresses, isJunkSerial, resolveSerial } from "./boxTargets.js";
import { parseFact, parseStep } from "./steps.js";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

test("a bare address gets adb's port", () => {
  assert.deepEqual(expandAddresses("192.168.1.10"), ["192.168.1.10:5555"]);
});

test("an address that already names a port keeps it", () => {
  assert.deepEqual(expandAddresses("192.168.1.10:5037"), ["192.168.1.10:5037"]);
});

test("a list is taken however it was pasted", () => {
  // Newlines, commas, stray whitespace and a trailing comment: all of them
  // turn up in an address list somebody copied out of a spreadsheet.
  assert.deepEqual(expandAddresses("  192.168.1.10 ,192.168.1.11\n\n192.168.1.12 # spare\n"), [
    "192.168.1.10:5555",
    "192.168.1.11:5555",
    "192.168.1.12:5555",
  ]);
});

test("the same address twice is one address", () => {
  assert.deepEqual(expandAddresses("192.168.1.10\n192.168.1.10:5555"), ["192.168.1.10:5555"]);
});

test("a /30 expands to its two usable hosts", () => {
  // Network and broadcast are skipped: .0 and .3 are not boxes.
  assert.deepEqual(expandAddresses("192.168.1.0/30"), ["192.168.1.1:5555", "192.168.1.2:5555"]);
});

test("a /24 expands to 254 hosts, not 256", () => {
  assert.equal(expandAddresses("10.0.0.0/24").length, 254);
});

test("a /32 is the one address, edges and all", () => {
  assert.deepEqual(expandAddresses("10.0.0.7/32"), ["10.0.0.7:5555"]);
});

test("a range wider than a /22 is refused rather than truncated", () => {
  // A sweep that silently did half of what was asked is worse than one that
  // said no -- and a wide sweep of a network nobody owns is a port scan.
  assert.throws(() => expandAddresses("10.0.0.0/16"), /at most 1024/);
});

test("nothing parseable is an error, not an empty scan", () => {
  assert.throws(() => expandAddresses("  \n # just a comment\n"), /no addresses/);
});

// ---------------------------------------------------------------------------
// Serials
// ---------------------------------------------------------------------------

test("reference-firmware serials are not identities", () => {
  // Every one of these ships unchanged on real boxes, so believing them means
  // the second box to enrol overwrites the first.
  for (const junk of ["", "unknown", "0123456789ABCDEF", "0000000000000000", "ffffffff"]) {
    assert.equal(isJunkSerial(junk), true, `${junk} should be junk`);
  }
});

test("a short serial is treated as absent whatever it says", () => {
  assert.equal(isJunkSerial("abc12"), true);
});

test("a real serial is left alone", () => {
  assert.equal(isJunkSerial("A1B2C3D4E5F6"), false);
});

const clean = {
  serial: "A1B2C3D4E5F6",
  duplicatedInScan: false,
  takenByDevice: false,
  claimedInFlight: false,
  alreadyEnrolled: false,
};

test("a good serial means the hub writes no override", () => {
  const out = resolveSerial(clean);
  assert.equal(out.resolved, "");
  assert.equal(out.source, "REPORTED");
});

test("a junk serial is always replaced, never just left", () => {
  // The invariant the whole feature turns on. Deciding a serial is unusable
  // and then writing nothing does not leave the box alone: the agent falls
  // through to a MAC address, enrols under something nobody predicted, and
  // the row is never claimed.
  const out = resolveSerial({ ...clean, serial: "0123456789ABCDEF" });
  assert.match(out.resolved, /^box-[a-z0-9_-]{10}$/);
  assert.equal(out.source, "MINTED");
});

test("two boxes in one scan reporting the same serial do not collide", () => {
  // Neither exists as a Device yet, so checking the database alone would pass
  // both and let the second overwrite the first.
  const out = resolveSerial({ ...clean, duplicatedInScan: true });
  assert.equal(out.source, "MINTED");
  assert.match(out.reason, /another box in this scan/);
});

test("a serial another device already holds is replaced", () => {
  const out = resolveSerial({ ...clean, takenByDevice: true });
  assert.equal(out.source, "MINTED");
});

test("re-provisioning a box keeps the serial it already enrolled under", () => {
  // `takenByDevice` is this box, not a collision. Minting here would orphan
  // its row, its name and its history -- the opposite of what re-provisioning
  // is for.
  const out = resolveSerial({ ...clean, takenByDevice: true, alreadyEnrolled: true });
  assert.equal(out.resolved, "");
  assert.equal(out.source, "REPORTED");
});

test("a serial an in-flight run already claimed is replaced", () => {
  const out = resolveSerial({ ...clean, claimedInFlight: true });
  assert.equal(out.source, "MINTED");
});

test("two mints in a row do not produce the same serial", () => {
  const a = resolveSerial({ ...clean, serial: "" });
  const b = resolveSerial({ ...clean, serial: "" });
  assert.notEqual(a.resolved, b.resolved);
});

// ---------------------------------------------------------------------------
// Parsing what the script says
// ---------------------------------------------------------------------------

test("a fact keeps spaces in its value", () => {
  // The reason `::fact` is three fields and a tail rather than key=value
  // pairs: this is what a Chromecast actually reports.
  assert.deepEqual(parseFact("::fact 192.168.1.10:5555 model Chromecast with Google TV"), {
    address: "192.168.1.10:5555",
    key: "model",
    value: "Chromecast with Google TV",
  });
});

test("a fact with no value parses as empty rather than null", () => {
  // An empty `ro.serialno` is a fact worth having -- it is what triggers a
  // minted serial -- so it must not be dropped as unparseable.
  assert.deepEqual(parseFact("::fact 192.168.1.10:5555 serial"), {
    address: "192.168.1.10:5555",
    key: "serial",
    value: "",
  });
});

test("run-level facts are addressed to a dash", () => {
  assert.equal(parseFact("::fact - adbPublicKey QAAAA... user@host")?.address, "-");
});

test("anything else on stdout is not a fact", () => {
  assert.equal(parseFact("* daemon started successfully"), null);
  assert.equal(parseFact("::step probe ok 4/8"), null);
});

test("a per-box step carries the address in its name", () => {
  // How one run's output is split back across the rows it belongs to.
  const step = parseStep("::step 192.168.1.10:5555/install fail magisk: not found");
  assert.equal(step?.name, "192.168.1.10:5555/install");
  assert.equal(step?.ok, false);
  assert.equal(step?.detail, "magisk: not found");
});

test("a warn step is not a failure", () => {
  assert.equal(parseStep("::step 192.168.1.10:5555/reboot warn not rebooted")?.ok, true);
});
