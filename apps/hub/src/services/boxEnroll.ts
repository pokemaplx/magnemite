import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BoxAdbResult } from "@magnemite/protocol";
import { generateToken, hashToken, prisma } from "@magnemite/db";
import { env } from "../env.js";
import { log } from "../log.js";
import { adbIdentity } from "./adbIdentity.js";
import { PUBLISH_DIR, sha256File } from "./agentRelease.js";
import { expandAddresses, resolveSerial } from "./boxTargets.js";
import { clampError } from "./redroid.js";
import { getConnection, sendTo } from "../registry.js";
import { type BootstrapStep, parseFact, parseStep, stepWriter } from "./stepWriter.js";

export { expandAddresses, isJunkSerial, resolveSerial } from "./boxTargets.js";

/**
 * Enrolling a hardware box over adb.
 *
 * The `hostBootstrap.ts` of boxes, and deliberately the same shape: a row per
 * target, `::step` progress written as it arrives, and a run that ends in
 * WAITING rather than DONE because adb finishing proves the box was
 * provisioned, not that it works. It still has to reboot and dial in, and the
 * enrollment is what closes the row out.
 *
 * Two things are different, and both come from what a box is.
 *
 * **It can be reached two ways.** A machine is a VPS with a public address.
 * A box is behind NAT in somebody's living room, which is the invariant the
 * rest of this system is built on -- so a hub on a VPS cannot open
 * `192.168.1.10:5555` and the normal path is to ask a machine already on that
 * LAN to run adb instead. Direct dial is for a hub at the site, or
 * development. Both run the same script; only the runner differs.
 *
 * **Its serial is its own.** The host flow mints one, because /etc/machine-id
 * is cloned by a VPS snapshot. A box has `ro.serialno`, which the agent
 * already prefers -- except when it is missing or shared with half a
 * production run, which on cheap reference firmware it often is. See
 * `resolveSerial`.
 */

/** Where the script and the module zip live inside the hub image. */
const SCRIPT = () => path.join(env.AGENT_BIN_DIR, "adb-enroll.sh");

/** A sweep is latency, not work. */
const SCAN_TIMEOUT_SECONDS = 300;
/** A push is ~5 MB per box over somebody's home wifi, done one at a time. */
const ENROLL_TIMEOUT_SECONDS = 1800;
/** The agent gives up first, so a hung relay answers rather than hanging. */
const RELAY_GRACE_MS = 30_000;

export type BoxCandidate = {
  address: string;
  /** `device`, `unauthorized` or `offline`. */
  state: string;
  reportedSerial: string;
  model: string;
  manufacturer: string;
  abi: string;
  sdk: string;
  /** `yes`, `no`, or `unknown` when we could not look. */
  root: string;
  enrolled: string;
  /** Set when a Device already holds the serial this box reports. */
  knownDeviceId: string | null;
  knownName: string | null;
  /** What the hub would write, and why. Empty means "let the box decide". */
  serial: string;
  /**
   * What this box will actually enrol under, which is what its row is keyed
   * on and what the claim matches.
   *
   * Computed here rather than by the caller: it is `serial` when the hub is
   * overriding and the box's own otherwise, and having the dashboard
   * re-derive that rule is how the two come to disagree about which box is
   * which.
   */
  expectedSerial: string;
  serialSource: "REPORTED" | "MINTED";
  serialReason: string;
  /** Whether this box can actually be enrolled as it stands. */
  eligible: boolean;
  blockedBy: string | null;
};

// ---------------------------------------------------------------------------
// Running the script
// ---------------------------------------------------------------------------

/**
 * One adb run at a time, per hub.
 *
 * `adb connect`, `disconnect` and the device list are global to the server on
 * :5037, so two runs at once see each other's boxes -- a probe would report
 * devices nobody asked about, and worse, an enrollment could act on one. A
 * chain rather than a lock because the queue is short and ordering is the
 * behaviour wanted anyway.
 *
 * Relay runs are not serialised here: they happen on different machines, each
 * with its own adb server, and the agent has its own one-at-a-time guard.
 */
let adbChain: Promise<unknown> = Promise.resolve();

function withAdb<T>(body: () => Promise<T>): Promise<T> {
  const next = adbChain.then(body, body);
  // Swallowed on the chain only: the caller still gets the rejection, but an
  // unhandled one here would take the process down and strand every queued run.
  adbChain = next.catch(() => undefined);
  return next;
}

type RunOptions = {
  mode: "probe" | "enroll";
  addresses?: string[];
  targets?: { address: string; serial: string; token: string }[];
  serverUrl?: string;
  reboot?: boolean;
  reprovision?: boolean;
  timeoutSeconds: number;
};

/**
 * Runs the script in this container.
 *
 * The environment is passed straight to `spawn` rather than through the 0600
 * file the SSH path writes. That file exists because an ssh exec request puts
 * the whole command in a shell's argv, which is world-readable through
 * /proc/<pid>/cmdline; a child's environment is readable only by its owner
 * and root, so here there is nothing to hide from.
 */
async function runLocal(options: RunOptions, onLine: (line: string) => void): Promise<void> {
  const script = SCRIPT();
  const exists = await fs
    .stat(script)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!exists) {
    throw new Error(
      `no adb-enroll script at ${script} — this hub image was built without the agent stage`,
    );
  }

  const identity = await adbIdentity();
  const zip = options.mode === "enroll" ? await moduleZip() : null;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MAGNEMITE_MODE: options.mode,
    MAGNEMITE_ADB_HOME: identity.home,
    MAGNEMITE_ADDRESSES: (options.addresses ?? []).join("\n"),
    MAGNEMITE_TARGETS: (options.targets ?? [])
      .map((t) => `${t.address}\t${t.serial}\t${t.token}`)
      .join("\n"),
    MAGNEMITE_SERVER: options.serverUrl ?? "",
    MAGNEMITE_ZIP: zip?.file ?? "",
    MAGNEMITE_REBOOT: options.reboot === false ? "0" : "1",
    MAGNEMITE_REPROVISION: options.reprovision ? "1" : "0",
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", [script], {
      env: childEnv,
      // stdin closed: nothing here reads it, and leaving it open is half of
      // how the adb server ends up holding a pipe nobody closes.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("the adb run took too long and was stopped"));
    }, options.timeoutSeconds * 1000);

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      tail += chunk.toString("utf8");
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => finish(err));
    // 'exit', not 'close'. `adb connect` forks a server daemon that outlives
    // this process and inherits its stdio, so the pipes can stay open after
    // the script itself is gone -- and 'close' waits for the pipes. The
    // script redirects the daemon's streams for the same reason; this is the
    // other half of the same guard, and the failure it prevents is a run that
    // hangs forever with its row stuck in RUNNING.
    child.on("exit", (code) => {
      if (tail) onLine(tail);
      if (code === 0) return finish(null);
      finish(new Error(stderr.trim() || `the adb run exited with code ${code}`));
    });
  });
}

/**
 * Asks a machine to run it instead, over the socket it already holds.
 *
 * The script travels with the request rather than being invoked where the
 * machine keeps it, for the reason the host bootstrap gives: the copy on the
 * machine is from the day it was provisioned, and a fix shipped in the hub
 * has to reach a run that is happening now.
 */
const relayWaiting = new Map<string, (result: BoxAdbResult) => void>();

async function runRelay(
  relayDeviceId: string,
  options: RunOptions,
  onLine: (line: string) => void,
): Promise<void> {
  if (!getConnection(relayDeviceId)) {
    throw new Error("that machine is offline — it has to be up to reach the boxes");
  }

  const [script, zip] = await Promise.all([
    fs.readFile(SCRIPT(), "utf8").catch(() => {
      throw new Error("this hub image has no adb-enroll script to send");
    }),
    options.mode === "enroll" ? publishModuleZip() : Promise.resolve(null),
  ]);

  const requestId = randomUUID();
  const sent = sendTo(relayDeviceId, {
    type: "box_adb",
    requestId,
    mode: options.mode,
    script,
    addresses: options.addresses ?? [],
    targets: options.targets ?? [],
    moduleUrl: zip?.url ?? null,
    moduleSha256: zip?.sha256 ?? null,
    serverUrl: options.serverUrl ?? "",
    reboot: options.reboot !== false,
    reprovision: options.reprovision === true,
    timeoutSeconds: options.timeoutSeconds,
  });
  if (!sent) throw new Error("the machine did not take the request");

  const result = await new Promise<BoxAdbResult>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        relayWaiting.delete(requestId);
        reject(
          new Error(
            "the machine did not answer — it may have gone offline, or its agent may be too old to enrol boxes",
          ),
        );
      },
      options.timeoutSeconds * 1000 + RELAY_GRACE_MS,
    );
    relayWaiting.set(requestId, (value) => {
      clearTimeout(timer);
      relayWaiting.delete(requestId);
      resolve(value);
    });
  });

  // Replayed as lines so both runners feed the same parser, and the caller
  // never has to know which one ran.
  for (const step of result.steps) {
    onLine(`::step ${step.name} ${step.ok ? "ok" : "fail"} ${step.detail}`);
  }
  for (const fact of result.facts) {
    onLine(`::fact ${fact.address} ${fact.key} ${fact.value}`);
  }
  if (!result.ok) throw new Error(result.error ?? "the machine could not run adb");
}

/** Called from the socket handler when a machine answers. */
export function resolveBoxAdb(result: BoxAdbResult): void {
  const resolve = relayWaiting.get(result.requestId);
  // No waiter left: the request timed out, or the hub restarted since.
  if (!resolve) return;
  resolve(result);
}

function run(
  relayDeviceId: string | null,
  options: RunOptions,
  onLine: (line: string) => void,
): Promise<void> {
  return relayDeviceId
    ? runRelay(relayDeviceId, options, onLine)
    : withAdb(() => runLocal(options, onLine));
}

// ---------------------------------------------------------------------------
// The module zip
// ---------------------------------------------------------------------------

async function moduleVersion(): Promise<string> {
  const version = await fs
    .readFile(path.join(env.AGENT_BIN_DIR, "VERSION"), "utf8")
    .then((v) => v.trim())
    .catch(() => null);
  if (!version) {
    throw new Error(
      "this hub image was built without the agent stage, so it has no module to install",
    );
  }
  return version;
}

async function moduleZip(): Promise<{ file: string; version: string }> {
  const version = await moduleVersion();
  const file = path.join(env.AGENT_BIN_DIR, `magnemite-agent-${version}.zip`);
  const exists = await fs
    .stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!exists) throw new Error(`no Magisk module at ${file}`);
  return { file, version };
}

/**
 * Puts the module zip where a machine can fetch it, and says where.
 *
 * Into the *same* versioned directory `agentRelease` publishes the binaries
 * to, and that is not tidiness: `pruneOldReleases` deletes every other
 * directory under `agent/`, so a zip published anywhere else would vanish on
 * the next boot and relay enrollment would start failing for no visible
 * reason.
 *
 * Deliberately not hung off `loadAgentRelease()`, which returns early when
 * AGENT_AUTO_UPDATE is off -- pinning the fleet's agent version must not
 * silently disable enrolling new boxes.
 */
async function publishModuleZip(): Promise<{ url: string; sha256: string }> {
  const { file, version } = await moduleZip();
  const name = path.basename(file);

  const publishDir = path.join(env.ARTIFACT_DIR, PUBLISH_DIR, version);
  await fs.mkdir(publishDir, { recursive: true });
  const dest = path.join(publishDir, name);

  const sha256 = await sha256File(file);
  // Only copy when the published one is missing or is not this build, so a
  // machine mid-download is not rewritten under.
  const published = await sha256File(dest).catch(() => null);
  if (published !== sha256) await fs.copyFile(file, dest);

  return {
    url: `${env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, "")}/files/${PUBLISH_DIR}/${version}/${name}`,
    sha256,
  };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export type ScanState = {
  id: string;
  startedAt: string;
  done: boolean;
  error: string | null;
  total: number;
  probed: number;
  found: BoxCandidate[];
};

/**
 * Scans live in memory, not in a table.
 *
 * A scan is ephemeral and loses nothing on a hub restart -- it can simply be
 * run again, and the dialog that was watching it is gone anyway. An
 * enrollment gets a row because it has to outlive the request and survive
 * until the box dials in; a scan has neither obligation.
 */
const scans = new Map<string, ScanState>();

/** Keeps a forgotten dialog's scan from living in memory forever. */
const SCAN_RETENTION_MS = 30 * 60 * 1000;

function pruneScans(): void {
  const cutoff = Date.now() - SCAN_RETENTION_MS;
  for (const [id, scan] of scans) {
    if (Date.parse(scan.startedAt) < cutoff) scans.delete(id);
  }
}

export function getScan(id: string): ScanState | null {
  return scans.get(id) ?? null;
}

/**
 * Starts a sweep and returns its id immediately.
 *
 * Not awaited: a /22 is minutes, and a relay adds the socket round trip on
 * top. The dialog polls.
 */
export function startScan(input: { addresses: string; relayDeviceId: string | null }): {
  id: string;
  total: number;
} {
  pruneScans();
  const addresses = expandAddresses(input.addresses);
  const id = randomUUID();
  const scan: ScanState = {
    id,
    startedAt: new Date().toISOString(),
    done: false,
    error: null,
    total: addresses.length,
    probed: 0,
    found: [],
  };
  scans.set(id, scan);

  void (async () => {
    const facts = new Map<string, Map<string, string>>();
    try {
      await run(
        input.relayDeviceId,
        { mode: "probe", addresses, timeoutSeconds: SCAN_TIMEOUT_SECONDS },
        (line) => {
          const fact = parseFact(line);
          if (fact) {
            if (fact.address === "-") {
              // Run-level. The only one today is the relay's adb public key,
              // which is how a machine's key reaches the adb_keys file.
              if (fact.key === "adbPublicKey" && input.relayDeviceId) {
                void prisma.redroidHost
                  .update({
                    where: { deviceId: input.relayDeviceId },
                    data: { adbPublicKey: fact.value },
                  })
                  .catch(() => undefined);
              }
              return;
            }
            let entry = facts.get(fact.address);
            if (!entry) facts.set(fact.address, (entry = new Map()));
            entry.set(fact.key, fact.value);
            return;
          }
          const step = parseStep(line);
          // `::step probe ok <done>/<total>` is the only progress there is.
          if (step?.name === "probe") {
            const done = Number(step.detail.split("/")[0]);
            if (Number.isFinite(done)) scan.probed = done;
          }
        },
      );
      scan.found = await describeCandidates(facts);
    } catch (err) {
      scan.error = clampError(err instanceof Error ? err.message : String(err));
      log.warn({ scanId: id, err: scan.error }, "box scan failed");
    } finally {
      scan.done = true;
      scan.probed = scan.total;
    }
  })();

  return { id, total: addresses.length };
}

/**
 * Turns raw facts into what the dialog shows, including the serial decision.
 *
 * The decision has to happen here rather than at enrollment, because it is
 * what the operator is being asked to approve: a box whose serial the hub is
 * about to override should say so before anybody clicks.
 */
async function describeCandidates(
  facts: Map<string, Map<string, string>>,
): Promise<BoxCandidate[]> {
  const addresses = [...facts.keys()].sort();
  const reported = new Map<string, string>();
  for (const address of addresses) {
    reported.set(address, (facts.get(address)?.get("serial") ?? "").trim());
  }

  // Everything the fleet already knows, in one query rather than one each.
  const known = await prisma.device.findMany({
    where: { serial: { in: [...new Set([...reported.values()].filter(Boolean))] } },
    select: { id: true, serial: true, name: true },
  });
  const bySerial = new Map(known.map((d) => [d.serial, d]));

  // Serials that are about to be claimed by a run still in flight. Without
  // this, two scans minutes apart can both decide the same reported serial is
  // free.
  const inFlight = await prisma.boxEnroll.findMany({
    where: { state: { in: ["RUNNING", "WAITING"] } },
    select: { serial: true },
  });
  const claimed = new Set(inFlight.map((r) => r.serial));

  // Duplicates *within this scan*. Two boxes off the same reference firmware
  // both report the same string and neither exists as a Device yet, so
  // checking the database alone would pass both and let the second overwrite
  // the first.
  const counts = new Map<string, number>();
  for (const serial of reported.values()) {
    if (serial) counts.set(serial, (counts.get(serial) ?? 0) + 1);
  }

  return addresses.map((address) => {
    const entry = facts.get(address) ?? new Map<string, string>();
    const serial = reported.get(address) ?? "";
    const state = entry.get("state") ?? "offline";
    const root = entry.get("root") ?? "unknown";
    const enrolled = entry.get("enrolled") ?? "unknown";
    const existing = serial ? (bySerial.get(serial) ?? null) : null;

    const { resolved, source, reason } = resolveSerial({
      serial,
      duplicatedInScan: (counts.get(serial) ?? 0) > 1,
      takenByDevice: Boolean(existing),
      claimedInFlight: claimed.has(serial),
      alreadyEnrolled: enrolled === "yes",
    });

    let blockedBy: string | null = null;
    if (state === "unauthorized") {
      blockedBy = "adb is not authorised — accept the key on the TV, or preseed it";
    } else if (state !== "device") {
      blockedBy = "no answer on this address";
    } else if (root !== "yes") {
      blockedBy = "no root via su — Magisk has to be installed and su granted to shell";
    } else if (enrolled === "yes") {
      blockedBy = "already enrolled";
    }

    return {
      address,
      state,
      reportedSerial: serial,
      model: entry.get("model") ?? "",
      manufacturer: entry.get("manufacturer") ?? "",
      abi: entry.get("abi") ?? "",
      sdk: entry.get("sdk") ?? "",
      root,
      enrolled,
      knownDeviceId: existing?.id ?? null,
      knownName: existing?.name ?? null,
      serial: resolved,
      expectedSerial: resolved || serial,
      serialSource: source,
      serialReason: reason,
      eligible: blockedBy === null,
      blockedBy,
    };
  });
}

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------

export type EnrollTarget = {
  address: string;
  /** Empty to let the box use its own `ro.serialno`. */
  serial: string;
  serialSource: "REPORTED" | "MINTED";
  /** The serial the row is keyed on, which is what the claim matches. */
  expectedSerial: string;
  name: string | null;
};

/**
 * Starts an enrollment and returns the batch id immediately.
 *
 * Not awaited, for the reason the host bootstrap is not: the run is minutes
 * and the dashboard would hold a connection open for all of it. Progress
 * lands on the rows.
 */
export async function startBoxEnroll(input: {
  targets: EnrollTarget[];
  desiredGroupId: string | null;
  relayDeviceId: string | null;
  reboot: boolean;
  reprovision: boolean;
}): Promise<{ batchId: string; rows: number }> {
  if (input.targets.length === 0) throw new Error("no boxes to enrol");

  const batchId = randomUUID();

  // One row per box, not per batch: the claim finds its row by serial when
  // the box dials in, so a batch of twelve has to be twelve rows. `batchId`
  // is only what lets the page show them as one thing.
  const rows = await Promise.all(
    input.targets.map((target) =>
      prisma.boxEnroll.create({
        data: {
          batchId,
          address: target.address,
          serial: target.expectedSerial,
          serialSource: target.serialSource,
          desiredName: target.name,
          desiredGroupId: input.desiredGroupId,
          relayDeviceId: input.relayDeviceId,
          state: "RUNNING",
        },
        select: { id: true, address: true },
      }),
    ),
  );

  // Deliberately not awaited. The tokens stay in this closure and go out of
  // scope when the run ends -- the database has only their hashes.
  void runEnroll(batchId, rows, input).catch((err) =>
    log.error({ err, batchId }, "box enrollment crashed"),
  );

  return { batchId, rows: rows.length };
}

async function runEnroll(
  batchId: string,
  rows: { id: string; address: string }[],
  input: {
    targets: EnrollTarget[];
    relayDeviceId: string | null;
    reboot: boolean;
    reprovision: boolean;
  },
): Promise<void> {
  const byAddress = new Map(rows.map((r) => [r.address, r.id]));
  const steps = new Map<string, BootstrapStep[]>();
  const writers = new Map<string, ReturnType<typeof stepWriter>>();

  for (const row of rows) {
    steps.set(row.id, []);
    writers.set(
      row.id,
      stepWriter(
        (value) => prisma.boxEnroll.update({ where: { id: row.id }, data: { steps: value } }),
        {
          boxEnrollId: row.id,
        },
      ),
    );
  }

  try {
    const targets = await Promise.all(
      input.targets.map(async (target) => ({
        address: target.address,
        serial: target.serial,
        token: await boxToken(target.address),
      })),
    );

    await run(
      input.relayDeviceId,
      {
        mode: "enroll",
        targets,
        serverUrl: env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, ""),
        reboot: input.reboot,
        reprovision: input.reprovision,
        timeoutSeconds: ENROLL_TIMEOUT_SECONDS,
      },
      (line) => {
        const step = parseStep(line);
        if (!step) return;
        // Steps are named `<address>/<stage>`, which is how one run's output
        // is split back across the rows it belongs to. Anything not addressed
        // to a box -- `done`, and the script's own failures -- is the run's,
        // and goes on every row so no box is left looking like it never ran.
        const slash = step.name.lastIndexOf("/");
        const address = slash > 0 ? step.name.slice(0, slash) : null;
        const stage = slash > 0 ? step.name.slice(slash + 1) : step.name;
        const ids = address ? [byAddress.get(address)].filter(Boolean) : rows.map((r) => r.id);
        for (const id of ids as string[]) {
          const list = steps.get(id);
          if (!list) continue;
          list.push({ ...step, name: stage });
          writers.get(id)?.(list);
        }
      },
    );

    await Promise.all([...writers.values()].map((w) => w.flush()));

    // WAITING, not DONE, and per row: a box whose own steps failed never
    // rebooted and is not coming, so calling it WAITING would leave a row
    // claiming to expect something.
    await Promise.all(
      rows.map((row) => {
        const list = steps.get(row.id) ?? [];
        const failed = list.find((s) => !s.ok);
        return prisma.boxEnroll.update({
          where: { id: row.id },
          data: failed
            ? {
                state: "FAILED",
                error: clampError(`${failed.name}: ${failed.detail}`),
                finishedAt: new Date(),
              }
            : { state: "WAITING" },
        });
      }),
    );
    log.info({ batchId, rows: rows.length }, "adb enrollment ran; waiting for boxes to dial in");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Promise.all([...writers.values()].map((w) => w.flush())).catch(() => undefined);
    await prisma.boxEnroll
      .updateMany({
        where: { batchId, state: "RUNNING" },
        data: { state: "FAILED", error: clampError(message), finishedAt: new Date() },
      })
      .catch(() => undefined);
    log.warn({ batchId, err: message }, "adb enrollment failed");
  }
}

/**
 * A BOX-scoped enrollment token for one box.
 *
 * One per box rather than one per batch, the way the host flow mints one per
 * machine: `maxUses: 1` means a token that leaks is a token for a box that
 * has already used it, and a box that failed can be retried without the
 * others' tokens still being live.
 *
 * `autoApprove` because the operator approved it by picking it off the scan;
 * making them approve it again in a second place is a step that teaches
 * nothing.
 */
async function boxToken(address: string): Promise<string> {
  const token = generateToken();
  await prisma.enrollmentToken.create({
    data: {
      label: `adb: ${address}`,
      tokenHash: hashToken(token),
      prefix: token.slice(0, 8),
      kind: "BOX",
      autoApprove: true,
      maxUses: 1,
      // A box that never comes back leaves this behind, and an auto-approving
      // token with no expiry is one that lives forever in a list nobody
      // revisits. A week is longer than any reboot and second attempt put
      // together.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// Closing the loop
// ---------------------------------------------------------------------------

/**
 * The live row for a serial, if the hub is the reason this box is enrolling.
 *
 * Read by enrollment *before* the Device is created, because the group and
 * the name have to be in the create: set afterwards, the box is already in
 * `default` and already holding that group's MITM config.
 *
 * `findFirst` on the newest rather than a unique lookup, because the serial
 * is not unique here -- a retry against the same box reuses its `ro.serialno`
 * and makes a second row.
 */
export async function findLiveBoxEnroll(serial: string) {
  return prisma.boxEnroll.findFirst({
    where: { serial, state: { in: ["RUNNING", "WAITING"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true, desiredGroupId: true, desiredName: true },
  });
}

/** Closes a row out when its box enrols. */
export async function claimBoxEnroll(rowId: string, deviceId: string): Promise<void> {
  await prisma.boxEnroll.update({
    where: { id: rowId },
    data: { state: "DONE", deviceId, finishedAt: new Date() },
  });
  log.info({ boxEnrollId: rowId, deviceId }, "box enrollment claimed");
}

/**
 * Fails enrollments that nothing is working on any more.
 *
 * A run lives in a closure in this process, so a hub that restarts mid-run --
 * a deploy, a crash, `tsx watch` noticing a file save -- leaves its rows in
 * RUNNING with nothing left to move them.
 *
 * WAITING is deliberately left alone, for the reason the bootstrap reaper
 * gives: it means adb finished and the box has not dialled in, which is a
 * legitimate thing to be for a few minutes while a box reboots.
 */
export async function reapOrphanedBoxEnrolls(): Promise<number> {
  const { count } = await prisma.boxEnroll.updateMany({
    where: { state: "RUNNING" },
    data: {
      state: "FAILED",
      error:
        "The hub restarted while this was running, so nothing was left watching it. " +
        "The box may be half-provisioned; enrolling it again is safe, and skips what is already done.",
      finishedAt: new Date(),
    },
  });
  if (count > 0) log.warn({ count }, "failed box enrollments orphaned by a hub restart");
  return count;
}
