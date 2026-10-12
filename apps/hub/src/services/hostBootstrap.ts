import fs from "node:fs/promises";
import path from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import { generateToken, hashToken, prisma } from "@magnemite/db";
import { env } from "../env.js";
import { log } from "../log.js";
import { clampError } from "./redroid.js";
import { REDROID_IMAGE } from "../version.js";

/**
 * Provisioning a machine over one outbound SSH connection.
 *
 * This is the only moment anything in Magnemite connects *towards* a machine.
 * Afterwards the agent dials out like any box and nothing here is needed again
 * — except to re-run, which is what covers the kernel-upgrade trap.
 *
 * Which is also why there is no secret store: the credential is used once,
 * held in a local for the duration of the run, and dropped. It is never
 * written to a row, to the log, or to the audit entry. A retry asks for it
 * again rather than keeping it warm.
 *
 * The invariant it does not break: boxes live behind NAT in other people's
 * homes and nothing may reach *them*. A VPS has a public address and is
 * already running sshd — that is how the provider handed it over — so one
 * outbound connection opens nothing new.
 */

/** Where the script and the binary land on the machine. */
const REMOTE_DIR = "/tmp/magnemite-bootstrap";

/**
 * How long the SSH half may take.
 *
 * Generous because the work genuinely is: apt, a Docker install, kernel
 * modules and possibly a reboot. Short enough that a machine which stopped
 * answering does not hold a row in RUNNING forever.
 */
const SSH_TIMEOUT_MS = 20 * 60 * 1000;

export type SshAccess = {
  host: string;
  port?: number;
  username: string;
  /** One or the other. Never both, and neither is stored. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

export type BootstrapStep = { name: string; ok: boolean; detail: string };

/**
 * Writes the step list to the row, one write at a time, latest wins.
 *
 * An earlier version fired an un-awaited `update` on every `::step` line, which
 * looked harmless and was not: the script prints arch, modules, binder and
 * pidmax within milliseconds of each other, so several updates overlapped on
 * one row and MariaDB rejected them with error 1020, "Record has changed since
 * last read". The progress stopped being written for the rest of the run.
 *
 * So: at most one write in flight, and a burst collapses into the newest state
 * rather than queueing a write per line. Nobody needs every intermediate list —
 * they need the latest one to arrive.
 *
 * The array is copied on the way in, because the caller keeps pushing to its
 * own and a reference would be serialised at whatever length it happened to
 * have when the query ran.
 */
function stepWriter(id: string) {
  let inFlight: Promise<void> | null = null;
  let pending: BootstrapStep[] | null = null;

  const write = async (steps: BootstrapStep[]): Promise<void> => {
    try {
      await prisma.redroidBootstrap.update({ where: { id }, data: { steps } });
    } catch (err) {
      // Progress is nice to have; the bootstrap is not. The same trade
      // recordSample makes — losing a line of progress must never fail a
      // provisioning that is otherwise working.
      log.warn({ err, bootstrapId: id }, "could not write bootstrap progress");
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

/**
 * Starts a bootstrap and returns its row id immediately.
 *
 * Not awaited, because the SSH half is minutes and the dashboard would hold a
 * connection open for all of it. Progress lands on the row as the script
 * prints its steps, and the row's own state is what the page renders.
 */
export async function startBootstrap(input: {
  name: string;
  access: SshAccess;
  desiredInstances: number;
  desiredWorkers: number | null;
}): Promise<{ id: string; serial: string }> {
  const serial = `host-${generateToken().slice(0, 10).toLowerCase()}`;

  const row = await prisma.redroidBootstrap.create({
    data: {
      name: input.name,
      serial,
      address: `${input.access.username}@${input.access.host}`,
      desiredInstances: input.desiredInstances,
      desiredWorkers: input.desiredWorkers,
      state: "RUNNING",
    },
  });

  // Deliberately not awaited. The credential stays in this closure and goes
  // out of scope when the run ends.
  void run(row.id, serial, input.name, input.access).catch((err) =>
    log.error({ err, bootstrapId: row.id }, "bootstrap crashed"),
  );

  return { id: row.id, serial };
}

async function run(id: string, serial: string, name: string, access: SshAccess): Promise<void> {
  const steps: BootstrapStep[] = [];

  try {
    const binary = await agentBinary();
    const script = await bootstrapScript();
    const token = await hostToken(name);

    await withConnection(access, async (client) => {
      await exec(client, `mkdir -p ${REMOTE_DIR}/redroid && chmod 700 ${REMOTE_DIR}`);
      await upload(client, binary, `${REMOTE_DIR}/magnemite-agent`, 0o755);
      await upload(client, script, `${REMOTE_DIR}/bootstrap.sh`, 0o755);

      // The three files that build the Redroid image, because there is nothing
      // to pull: the tag is local and this project publishes no registry.
      // Without them a provisioned machine enrols, reports, and then fails its
      // first converge on an image that was never going to exist.
      for (const [name, mode] of [
        ["Dockerfile", 0o644],
        ["magnemite-start.sh", 0o755],
        ["magnemite.rc", 0o644],
      ] as const) {
        await upload(client, await redroidFile(name), `${REMOTE_DIR}/redroid/${name}`, mode);
      }

      // The token is passed in the environment rather than on the command
      // line, so it does not land in the machine's process list where any
      // other user could read it.
      const command = [
        `cd ${REMOTE_DIR}`,
        [
          `MAGNEMITE_SERVER=${shellQuote(env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, ""))}`,
          `MAGNEMITE_SERIAL=${shellQuote(serial)}`,
          `MAGNEMITE_NAME=${shellQuote(name)}`,
          `MAGNEMITE_TOKEN=${shellQuote(token)}`,
          // The tag the compose file will name. One value from one place, so
          // the machine cannot build one image and be asked to run another.
          `MAGNEMITE_IMAGE=${shellQuote(REDROID_IMAGE)}`,
          `AGENT_BIN=./magnemite-agent`,
          "sh ./bootstrap.sh",
        ].join(" "),
      ].join(" && ");

      const publish = stepWriter(id);
      await exec(client, command, (line) => {
        const step = parseStep(line);
        if (!step) return;
        steps.push(step);
        // Written as they arrive, so the page fills in rather than jumping
        // from nothing to done twenty minutes later.
        publish(steps);
      });
      await publish.flush();
    });

    // WAITING, not DONE. The script exiting zero proves the machine was
    // prepared, not that it works: a step may have installed a kernel module
    // needing a reboot, after which SSH is gone and the only proof left is the
    // socket. `claimBootstrap` is what closes this out, when the machine
    // actually dials in.
    await prisma.redroidBootstrap.update({
      where: { id },
      data: { state: "WAITING", steps },
    });
    log.info({ bootstrapId: id, serial }, "bootstrap ran; waiting for the machine to dial in");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.redroidBootstrap
      .update({
        where: { id },
        data: {
          state: "FAILED",
          steps,
          error: clampError(message),
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    log.warn({ bootstrapId: id, err: message }, "bootstrap failed");
  }
}

/**
 * Closes out a bootstrap when its machine enrols.
 *
 * Called from enrolment, and this is the piece that makes the whole thing one
 * action rather than four: the machine is marked adopted without asking,
 * because the hub provisioned it and therefore knows it was empty — the
 * adoption gate exists for machines whose prior state is *unknown*. Then the
 * instance count the operator typed is applied.
 */
export async function claimBootstrap(deviceId: string, serial: string): Promise<void> {
  const row = await prisma.redroidBootstrap.findUnique({
    where: { serial },
    select: { id: true, state: true, desiredInstances: true, desiredWorkers: true },
  });
  if (!row || row.state === "DONE") return;

  await prisma.redroidBootstrap.update({
    where: { id: row.id },
    data: { state: "DONE", deviceId, finishedAt: new Date() },
  });

  // Known-empty, so adopting is a fact rather than an assumption.
  await prisma.redroidHost.update({
    where: { deviceId },
    data: { adoptedAt: new Date() },
  });

  log.info(
    { deviceId, serial, instances: row.desiredInstances },
    "bootstrap claimed; machine adopted",
  );

  if (row.desiredInstances > 0) {
    // Imported here rather than at the top: redroid.ts imports this module for
    // clampError, and a static cycle would leave one of them half-initialised.
    const { setInstanceCount, convergeHost } = await import("./redroid.js");
    await setInstanceCount(deviceId, row.desiredInstances, row.desiredWorkers);
    await convergeHost(deviceId);
  }
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

function withConnection<T>(access: SshAccess, body: (client: Client) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error("the machine stopped answering during the bootstrap"));
    }, SSH_TIMEOUT_MS);

    const done = (err: Error | null, value?: T) => {
      clearTimeout(timer);
      client.end();
      if (err) reject(err);
      else resolve(value as T);
    };

    const config: ConnectConfig = {
      host: access.host,
      port: access.port ?? 22,
      username: access.username,
      // No host key is pinned, and saying so is better than implying one is.
      // The machine was handed over minutes ago by the provider and there is
      // no prior key to compare against; the integrity that matters here is
      // the token, which never travels in the clear.
      readyTimeout: 30_000,
      keepaliveInterval: 15_000,
    };
    if (access.privateKey) {
      config.privateKey = access.privateKey;
      if (access.passphrase) config.passphrase = access.passphrase;
    } else if (access.password) {
      config.password = access.password;
    }

    client.on("ready", () => {
      body(client).then(
        (value) => done(null, value),
        (err) => done(err instanceof Error ? err : new Error(String(err))),
      );
    });
    client.on("error", (err) => done(new Error(`could not reach ${access.host}: ${err.message}`)));

    try {
      client.connect(config);
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Runs a command, streaming each stdout line to `onLine`. */
function exec(client: Client, command: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);

      let tail = "";
      let stderr = "";

      stream.on("data", (chunk: Buffer) => {
        if (!onLine) return;
        // Lines arrive split across chunks, so the remainder is carried.
        tail += chunk.toString("utf8");
        const lines = tail.split("\n");
        tail = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        // Kept, and capped: the script's failures go here, and this is where
        // the reason an operator needs usually is.
        if (stderr.length < 8_000) stderr += chunk.toString("utf8");
      });

      stream.on("close", (code: number) => {
        if (tail && onLine) onLine(tail);
        if (code === 0) return resolve();
        reject(new Error(stderr.trim() || `the bootstrap exited with code ${code}`));
      });
    });
  });
}

/** SFTP, because scp would mean shelling out to a binary the image may not have. */
function upload(client: Client, content: Buffer, remote: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remote, { mode });
      stream.on("close", () => resolve());
      stream.on("error", reject);
      stream.end(content);
    });
  });
}

// ---------------------------------------------------------------------------
// What gets pushed
// ---------------------------------------------------------------------------

/**
 * The arm64 agent out of the hub's own image.
 *
 * Pushed over the connection that is already open rather than downloaded by
 * the machine, which dissolves the chicken and egg: the machine would need the
 * binary to enrol, and a token to download it, and it has neither yet.
 */
async function agentBinary(): Promise<Buffer> {
  const file = path.join(env.AGENT_BIN_DIR, "magnemite-agent-linux-arm64");
  try {
    return await fs.readFile(file);
  } catch {
    throw new Error(
      `no arm64 agent at ${file} — this hub image was built without the Go stage, so it has no binary to install`,
    );
  }
}

/**
 * One of the files that build the Redroid image, out of the hub's own image.
 *
 * Beside the agent builds, which is where the hub's Dockerfile puts them.
 */
async function redroidFile(name: string): Promise<Buffer> {
  const file = path.join(env.AGENT_BIN_DIR, "redroid", name);
  try {
    return await fs.readFile(file);
  } catch {
    throw new Error(`no ${name} at ${file} — this hub image cannot build the Redroid image`);
  }
}

async function bootstrapScript(): Promise<Buffer> {
  // Beside the binaries, which is where the hub's Dockerfile puts it.
  const file = path.join(env.AGENT_BIN_DIR, "bootstrap.sh");
  try {
    return await fs.readFile(file);
  } catch {
    throw new Error(`no bootstrap script at ${file}`);
  }
}

/**
 * A HOST-scoped enrollment token for this machine.
 *
 * `autoApprove` is forced, and not offered: `/internal/authz` refuses an
 * unapproved device, so a machine that enrolled pending would get a bare 401
 * from the edge on its first self-update with nothing anywhere to say why.
 *
 * `maxUses: 1`, because exactly one machine will ever present it.
 */
async function hostToken(name: string): Promise<string> {
  const token = generateToken();
  await prisma.enrollmentToken.create({
    data: {
      label: `bootstrap: ${name}`,
      tokenHash: hashToken(token),
      prefix: token.slice(0, 8),
      kind: "HOST",
      autoApprove: true,
      maxUses: 1,
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// Parsing the script's own output
// ---------------------------------------------------------------------------

/**
 * `::step <name> <ok|warn|fail> [detail]`.
 *
 * The script prints these so a bootstrap that fails on the fourth stage can
 * say which, rather than just failing. Anything else on stdout is ignored —
 * apt and docker are noisy and none of it is structured.
 */
export function parseStep(line: string): BootstrapStep | null {
  const match = /^::step\s+(\S+)\s+(ok|warn|fail)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return {
    name: match[1]!,
    // A warning is not a failure: swap that could not be created leaves a
    // machine that runs, and calling it a failure would stop a provisioning
    // that was going to work.
    ok: match[2] !== "fail",
    detail: (match[3] ?? "").trim(),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
