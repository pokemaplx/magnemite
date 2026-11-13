import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@magnemite/db";
import { log } from "../log.js";

const run = promisify(execFile);

/**
 * The one adb identity the hub presents to a box.
 *
 * It matters because of what the TV remembers: adb authenticates with
 * `$HOME/.android/adbkey`, and the public half is what "Always allow from
 * this computer" is a decision about. Lose the key and every box in the fleet
 * asks again -- with a dialog, in a living room, where nobody is standing.
 *
 * Two things here are deliberate and neither is obvious.
 *
 * **It lives in the database, not in ARTIFACT_DIR.** That volume is the
 * obvious home and it is the wrong one: it is *served*. `/files/*` rejects a
 * path only when `path.basename` starts with a dot, so `adb/.android/adbkey`
 * has basename `adbkey` and would be handed to any approved device token that
 * asked for it -- and an adb key plus `su` is a root shell on every box that
 * ever trusted it.
 *
 * **ANDROID_USER_HOME does nothing.** It is honoured by the SDK's Java tools;
 * the adb binary reads `HOME` and falls back to `getpwuid_r`. So the lever is
 * HOME, pointed at a directory materialised from the row.
 */

/** Where the key is written for adb to find. Rebuilt from the row on demand. */
const HOME_DIR = path.join(os.tmpdir(), "magnemite-adb");

type Identity = { home: string; publicKey: string };

let cached: Identity | null = null;

/**
 * The hub's key, generated on first use and materialised on disk for adb.
 *
 * Cached for the life of the process: the row does not change, and every scan
 * and every enrollment needs this.
 */
export async function adbIdentity(): Promise<Identity> {
  if (cached) return cached;

  const androidDir = path.join(HOME_DIR, ".android");
  await fs.mkdir(androidDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, and the one thing that must be true here
  // is that nobody else on the host can read the key.
  await fs.chmod(HOME_DIR, 0o700);
  await fs.chmod(androidDir, 0o700);

  const keyFile = path.join(androidDir, "adbkey");
  const pubFile = `${keyFile}.pub`;

  const row = await prisma.adbIdentity.findUnique({ where: { id: "singleton" } });
  if (row) {
    await fs.writeFile(keyFile, row.privateKeyPem, { mode: 0o600 });
    await fs.writeFile(pubFile, row.publicKey, { mode: 0o644 });
    cached = { home: HOME_DIR, publicKey: row.publicKey };
    return cached;
  }

  // Minted by adb itself rather than by node:crypto. The private half is an
  // ordinary PKCS#8 PEM, but the public half is Android's own packed
  // RSAPublicKey encoding -- reimplementing that to save a subprocess would
  // be a day of work and a format to get subtly wrong.
  await fs.rm(keyFile, { force: true });
  await fs.rm(pubFile, { force: true });
  await run("adb", ["keygen", keyFile]);

  const [privateKeyPem, publicKey] = await Promise.all([
    fs.readFile(keyFile, "utf8"),
    fs.readFile(pubFile, "utf8"),
  ]);

  // Upserted, not created: two requests can race here on a cold hub, and the
  // loser must end up using the winner's key rather than failing. Whichever
  // row wins, both processes re-read it below.
  await prisma.adbIdentity.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", privateKeyPem, publicKey },
    update: {},
  });
  const stored = await prisma.adbIdentity.findUniqueOrThrow({ where: { id: "singleton" } });
  if (stored.privateKeyPem !== privateKeyPem) {
    await fs.writeFile(keyFile, stored.privateKeyPem, { mode: 0o600 });
    await fs.writeFile(pubFile, stored.publicKey, { mode: 0o644 });
  }

  log.info("minted the hub's adb identity");
  cached = { home: HOME_DIR, publicKey: stored.publicKey };
  return cached;
}

/**
 * Every adb public key the fleet uses, as an `adb_keys` file.
 *
 * The hub's, plus each machine's own -- one key per line, which is the format
 * `/data/misc/adb/adb_keys` wants. Preseeding this one file into a golden
 * image is what turns box enrollment from "tap Allow on every TV" into
 * something that runs unattended.
 *
 * Machines keep their own keys rather than sharing the hub's on purpose: a
 * key a box has trusted is, with `su`, a root shell on that box, and a relay
 * can be a machine in somebody's living room. One compromised relay must not
 * be root on the whole fleet, and revoking one must not re-pair it.
 */
export async function adbKeysFile(): Promise<string> {
  const [hub, machines] = await Promise.all([
    adbIdentity().catch(() => null),
    prisma.redroidHost.findMany({
      where: { adbPublicKey: { not: null } },
      select: { adbPublicKey: true, device: { select: { name: true } } },
    }),
  ]);

  const lines: string[] = [];
  if (hub) lines.push(hub.publicKey.trim());
  for (const machine of machines) {
    const key = machine.adbPublicKey?.trim();
    if (key) lines.push(key);
  }
  // Deduplicated, because a hub that once shipped its key to a machine would
  // otherwise have it twice and adb would check it twice.
  return [...new Set(lines)].join("\n") + "\n";
}
