import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import type { HostBootstrapResult } from "@magnemite/protocol";
import { generateToken, hashToken, prisma } from "@magnemite/db";
import { env } from "../env.js";
import { log } from "../log.js";
import { clampError } from "./redroid.js";
import { getConnection, sendTo } from "../registry.js";
import { type BootstrapStep, parseStep, stepWriter } from "./stepWriter.js";
import { REDROID_IMAGE, REDROID_IMAGE_SOURCE } from "../version.js";

// Re-exported from where they have always lived, so nothing that imports them
// from here has to care that the machine bootstrap and the adb box enrollment
// now share one copy.
export { parseStep };
export type { BootstrapStep };

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

/**
 * How long a re-run over the socket may take.
 *
 * Longer than the SSH half's, because it can include an image build on a
 * machine that is also running containers. It is also what decides when an
 * in-flight run is written off as lost: past it, asking again is the right
 * move rather than something to refuse.
 */
const BOOTSTRAP_TIMEOUT_SECONDS = 30 * 60;

/**
 * Fails bootstraps that nothing is working on any more.
 *
 * A run lives in a closure in this process, so a hub that restarts mid-run --
 * a deploy, a crash, `tsx watch` noticing a file save -- leaves its row in
 * RUNNING with nothing left to move it. Before this, that row said "docker…"
 * forever and the only way out was SQL.
 *
 * Called on boot, which is exactly when the orphans exist: anything still
 * RUNNING cannot be ours, because ours had not started yet.
 *
 * WAITING is deliberately left alone. That state means the SSH half finished
 * and the machine has not dialled in, which is a legitimate thing to be for a
 * while -- a bootstrap may have installed a kernel module needing a reboot,
 * and the machine is the only thing that can close it out.
 */
export async function reapOrphanedBootstraps(): Promise<number> {
  const { count } = await prisma.redroidBootstrap.updateMany({
    where: { state: "RUNNING" },
    data: {
      state: "FAILED",
      error:
        "The hub restarted while this was running, so nothing was left watching it. " +
        "The machine may be half-provisioned; the bootstrap is safe to run again, " +
        "and skips what is already done.",
      finishedAt: new Date(),
    },
  });
  if (count > 0) log.warn({ count }, "failed bootstraps orphaned by a hub restart");
  return count;
}

export type SshAccess = {
  host: string;
  port?: number;
  username: string;
  /** One or the other. Never both, and neither is stored. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

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
  desiredGroupId: string | null;
  desiredNameTemplate: string | null;
}): Promise<{ id: string; serial: string }> {
  const serial = `host-${generateToken().slice(0, 10).toLowerCase()}`;

  const row = await prisma.redroidBootstrap.create({
    data: {
      name: input.name,
      serial,
      address: `${input.access.username}@${input.access.host}`,
      desiredInstances: input.desiredInstances,
      desiredWorkers: input.desiredWorkers,
      desiredGroupId: input.desiredGroupId,
      desiredNameTemplate: input.desiredNameTemplate,
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

      // Everything that builds the Redroid image, which is the fallback now
      // that CI publishes one: a machine that cannot reach ghcr.io, or an
      // image bumped in a branch CI has not published yet, still has to end up
      // with the tag its compose file names — otherwise it enrols, reports,
      // and fails its first converge on an image that was never going to
      // exist.
      //
      // This list and the Dockerfile's COPY lines have to agree. A file the
      // Dockerfile names and this does not makes `docker build` fail on a
      // machine nobody is watching — the bootstrap only *warns* on a failed
      // image build, by design, so the first symptom is a converge that cannot
      // find the image, minutes later and somewhere else.
      for (const [name, mode] of [
        ["Dockerfile", 0o644],
        ["magnemite-start.sh", 0o755],
        ["magnemite-root-grant.sh", 0o755],
        ["magnemite.rc", 0o644],
      ] as const) {
        await upload(client, await redroidFile(name), `${REMOTE_DIR}/redroid/${name}`, mode);
      }

      // Uploaded as a file and sourced, rather than written into the command.
      //
      // An ssh exec request is run as `$SHELL -c '<command>'`, so everything
      // in it is that shell's argv — and argv is world-readable through
      // /proc/<pid>/cmdline, for the minutes a bootstrap takes. The enrollment
      // token would be sitting there for any other user on the machine. An
      // environment is readable only by root and the process's owner, which is
      // the difference being bought here.
      //
      // Deleted by the same command that sources it, so the file exists for
      // the moment between the two: it is 0600 in a 0700 directory, and the
      // variables it set survive in the environment the script inherits.
      const envFile =
        [
          `export MAGNEMITE_SERVER=${shellQuote(env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, ""))}`,
          `export MAGNEMITE_SERIAL=${shellQuote(serial)}`,
          `export MAGNEMITE_NAME=${shellQuote(name)}`,
          `export MAGNEMITE_TOKEN=${shellQuote(token)}`,
          // The tag the compose file will name. One value from one place, so
          // the machine cannot build one image and be asked to run another.
          `export MAGNEMITE_IMAGE=${shellQuote(REDROID_IMAGE)}`,
          // And where to get it: the bootstrap pulls this and retags it as the
          // local tag above, falling back to building when it cannot. The two
          // are separate on purpose — a registry reference in the rendered
          // compose file would recreate every container on every machine
          // already running.
          `export MAGNEMITE_IMAGE_SOURCE=${shellQuote(REDROID_IMAGE_SOURCE)}`,
          // The port the firewall has to keep open, which is the one this
          // connection just came in on. Hardcoding 22 on a machine whose sshd
          // listens elsewhere would lock the operator out of their own VPS
          // halfway through provisioning it.
          `export MAGNEMITE_SSH_PORT=${shellQuote(String(access.port ?? 22))}`,
          `export AGENT_BIN=./magnemite-agent`,
        ].join("\n") + "\n";
      await upload(client, Buffer.from(envFile, "utf8"), `${REMOTE_DIR}/bootstrap.env`, 0o600);

      const command = [
        `cd ${REMOTE_DIR}`,
        ". ./bootstrap.env",
        "rm -f ./bootstrap.env",
        "sh ./bootstrap.sh",
      ].join(" && ");

      const publish = stepWriter(
        (steps) => prisma.redroidBootstrap.update({ where: { id }, data: { steps } }),
        { bootstrapId: id },
      );
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
    select: {
      id: true,
      state: true,
      desiredInstances: true,
      desiredWorkers: true,
      desiredGroupId: true,
      desiredNameTemplate: true,
    },
  });
  if (!row || row.state === "DONE") return;

  await prisma.redroidBootstrap.update({
    where: { id: row.id },
    data: { state: "DONE", deviceId, finishedAt: new Date() },
  });

  // Known-empty, so adopting is a fact rather than an assumption.
  //
  // The group travels in the same write, and the ordering is the whole point:
  // the containers are started below, their boxes enrol as they come up, and
  // enrolment reads `defaultGroupId` off this row. Set it afterwards and every
  // box of the first batch is already in `default`.
  await prisma.redroidHost.update({
    where: { deviceId },
    data: {
      adoptedAt: new Date(),
      ...(row.desiredGroupId ? { defaultGroupId: row.desiredGroupId } : {}),
      ...(row.desiredNameTemplate ? { nameTemplate: row.desiredNameTemplate } : {}),
    },
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
/**
 * The files that build the Redroid image, for a re-run over the socket.
 *
 * The same four the SSH path pushes, and the same list the two Dockerfiles
 * name — see the comment on the upload loop above. Their modes travel with
 * them because one of them is a script.
 */
async function redroidFiles(): Promise<{ name: string; content: string; mode: string }[]> {
  const wanted = [
    ["Dockerfile", "0644"],
    ["magnemite-start.sh", "0755"],
    ["magnemite-root-grant.sh", "0755"],
    ["magnemite.rc", "0644"],
  ] as const;
  return Promise.all(
    wanted.map(async ([name, mode]) => ({
      name,
      content: (await redroidFile(name)).toString("utf8"),
      mode,
    })),
  );
}

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
      // A run that never finishes leaves this token behind, and an
      // auto-approving HOST token with no expiry is one that lives forever —
      // in a list nobody revisits, for a machine that may have been
      // decommissioned. A week is longer than any real provisioning, reboot
      // and second attempt put together, and short enough that forgetting it
      // is not permanent.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Re-running the bootstrap
// ---------------------------------------------------------------------------

/**
 * Ask a machine to run its provisioning script again.
 *
 * Over its own socket, with no SSH and no credential — which is the whole
 * reason the script installs a copy of itself on each machine. What it covers
 * is the one failure in this feature that happens with nobody touching
 * anything: `linux-modules-extra` is per kernel version, so a kernel upgrade
 * leaves binder behind and every container stops coming up after the reboot.
 *
 * **The files travel with the request**, and that is not an optimisation. The
 * copies on the machine are from the day it was provisioned, and a re-run
 * whose point is to deliver a fixed image cannot be done with the very files
 * being replaced. The script also looks for `./redroid` relative to where it
 * runs, so sending it alone would re-run everything except the image build.
 *
 * No token, no server URL, no serial: the machine's own config already holds
 * those and the script keeps an existing one. Re-running must not make a
 * machine enrol a second time.
 */
export async function rerunBootstrap(
  deviceId: string,
): Promise<{ sent: boolean; reason?: string }> {
  const host = await prisma.redroidHost.findUnique({
    where: { deviceId },
    select: { deviceId: true, image: true, bootstrapRanAt: true, bootstrapOk: true },
  });
  if (!host) return { sent: false, reason: "that machine has not enrolled yet" };

  // One at a time, refused here rather than on the machine. The agent refuses
  // a second run too, but by then it has been recorded as a failed one and the
  // first run's steps are gone -- so the operator would be told about a
  // failure that is really their own second click.
  //
  // `bootstrapOk` null with a time set is the in-flight state: set when the
  // request goes out, filled when the machine reports. Past the ceiling it is
  // not in flight any more, it is lost, and asking again is right.
  if (host.bootstrapRanAt && host.bootstrapOk === null) {
    const running = Date.now() - host.bootstrapRanAt.getTime();
    if (running < BOOTSTRAP_TIMEOUT_SECONDS * 1000) {
      return {
        sent: false,
        reason: `already running, started ${Math.round(running / 60000)} minutes ago`,
      };
    }
  }
  if (!getConnection(deviceId)) {
    // Deliberately not queued. A bootstrap is minutes of apt and an image
    // build, and one that starts the moment a machine reconnects — possibly
    // in the middle of the night, possibly because it just rebooted — is not
    // something to begin without somebody watching.
    return { sent: false, reason: "offline — the machine has to be up to run it" };
  }

  const [script, files] = await Promise.all([bootstrapScript(), redroidFiles()]);

  // The machine's own pin when it has one, the fleet's tag otherwise -- the
  // same resolution convergeHost does, so a machine held on an older image on
  // purpose is not quietly dragged forward by a re-run.
  const image = host.image ?? REDROID_IMAGE;

  const requestId = randomUUID();
  const sent = sendTo(deviceId, {
    type: "host_bootstrap",
    requestId,
    script: script.toString("utf8"),
    files,
    image,
    timeoutSeconds: BOOTSTRAP_TIMEOUT_SECONDS,
  });
  if (!sent) return { sent: false, reason: "the machine did not take the request" };

  // Marked in flight before anything can report. Without this the page shows
  // the *previous* run's steps while this one works -- stale green while
  // something is happening, which is the version of "no feedback" that
  // actively misleads.
  await prisma.redroidHost.update({
    where: { deviceId },
    data: { bootstrapRanAt: new Date(), bootstrapOk: null, bootstrapSteps: [] },
  });

  log.info({ deviceId, requestId, image }, "bootstrap re-run dispatched");
  return { sent: true };
}

/** Stores what a re-run reported. */
export async function recordBootstrapResult(
  deviceId: string,
  result: HostBootstrapResult,
): Promise<void> {
  await prisma.redroidHost.update({
    where: { deviceId },
    data: {
      bootstrapSteps: result.steps,
      bootstrapRanAt: new Date(),
      bootstrapOk: result.ok,
      // Shares the field the converge failures use, so the machine page has
      // one place that answers "what went wrong here last" rather than two
      // that each answer half -- and a run that worked **clears** it, because
      // a machine just repaired still showing "Last failure" is how an
      // operator stops believing that card at all.
      ...(result.ok
        ? { lastError: null, lastErrorAt: null }
        : {
            lastError: clampError(result.error ?? "the bootstrap failed"),
            lastErrorAt: new Date(),
          }),
    },
  });
  log.info({ deviceId, ok: result.ok, steps: result.steps.length }, "bootstrap re-run reported");
}
