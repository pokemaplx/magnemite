import { randomBytes } from "node:crypto";

/**
 * Working out what to point adb at, and what identity the box will have.
 *
 * Separated from `boxEnroll.ts` because all of it is pure -- no database, no
 * environment, no sockets -- and because that is the half worth testing
 * exhaustively. Importing the service pulls in `env.js`, which exits a
 * process whose environment is not a hub's, so the tests could not reach any
 * of this while it lived there.
 */

/**
 * The widest sweep allowed, which is a /22.
 *
 * Not a performance limit. A sweep opens a TCP connection to every address in
 * it, and a wide one against a network the operator does not own looks
 * exactly like a port scan, because it is one.
 */
const MAX_ADDRESSES = 1024;

/**
 * Serials that are not identities.
 *
 * Amlogic and Rockchip reference firmware ships these unchanged, so a dozen
 * boxes off the same batch report the same string. `Device.serial` is unique,
 * so believing one would mean the second box to enrol silently overwrites the
 * first -- the row, its group, its history, all of it.
 *
 * Matched case-insensitively, and anything under six characters is treated as
 * absent whether or not it is listed.
 */
const JUNK_SERIALS = new Set([
  "",
  "unknown",
  "0123456789abcdef",
  "1234567890",
  "0000000000000000",
  "000000000000",
  "deadbeef",
  "androidtv",
  "rockchip",
  "amlogic",
]);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Turns what the operator typed into a list of `ip:port`.
 *
 * Accepts a free-text list -- one per line, commas and whitespace tolerated,
 * `#` comments stripped, the way a hosts file is written -- and CIDR blocks,
 * which it expands. Throws rather than truncating: a sweep that silently did
 * half of what was asked is worse than one that refused.
 */
export function expandAddresses(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const withPort = trimmed.includes(":") ? trimmed : `${trimmed}:5555`;
    if (seen.has(withPort)) return;
    seen.add(withPort);
    out.push(withPort);
  };

  for (const raw of input.split(/[\n,]/)) {
    const token = raw.replace(/#.*$/, "").trim();
    if (!token) continue;

    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(token);
    if (!cidr) {
      push(token);
      continue;
    }

    const bits = Number(cidr[2]);
    if (bits < 22 || bits > 32) {
      throw new Error(
        `${token} is not a range this will sweep — between /22 and /32, so at most ${MAX_ADDRESSES} addresses`,
      );
    }
    const octets = cidr[1]!.split(".").map(Number);
    if (octets.some((o) => o > 255)) throw new Error(`${token} is not an address`);

    const base = ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
    const size = 2 ** (32 - bits);
    const network = base & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0);
    // Network and broadcast are skipped for anything wider than a /31, where
    // the concept does not apply and both addresses are real hosts.
    const skipEdges = bits <= 30;
    for (let i = skipEdges ? 1 : 0; i < (skipEdges ? size - 1 : size); i++) {
      const addr = (network + i) >>> 0;
      push(`${(addr >>> 24) & 255}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}`);
    }
  }

  if (out.length === 0) throw new Error("no addresses to scan");
  if (out.length > MAX_ADDRESSES) {
    throw new Error(
      `${out.length} addresses is more than this will sweep at once (${MAX_ADDRESSES})`,
    );
  }
  return out;
}

/** Whether a reported `ro.serialno` is an identity or just a string. */
export function isJunkSerial(serial: string): boolean {
  const value = serial.trim().toLowerCase();
  if (value.length < 6) return true;
  if (JUNK_SERIALS.has(value)) return true;
  // All one character, which covers every length of zeros and Fs at once.
  if (/^(.)\1*$/.test(value)) return true;
  if (value.startsWith("emulator")) return true;
  return false;
}

/**
 * Which serial this box should enrol under.
 *
 * The rule, and the part of this feature most likely to be broken by a
 * well-meaning simplification: **whenever the reported serial is not
 * confidently good, the hub must write an override.** Not "may" -- must.
 *
 * Deciding a serial is unusable and then writing nothing does not leave the
 * box alone: the agent falls through `ro.serialno` to `ro.boot.serialno` to a
 * MAC address, so the box enrols under a value the hub never predicted, the
 * row keyed on the old one is never claimed, and the box lands in the fleet
 * ungrouped, unnamed, and waiting to be reaped.
 *
 * An empty `resolved` means "let the box decide", and is only ever returned
 * when the box's own serial is known to be good.
 */
export function resolveSerial(input: {
  serial: string;
  duplicatedInScan: boolean;
  takenByDevice: boolean;
  claimedInFlight: boolean;
  alreadyEnrolled: boolean;
}): { resolved: string; source: "REPORTED" | "MINTED"; reason: string } {
  const mint = (reason: string) => ({
    resolved: `box-${randomBytes(8).toString("hex").slice(0, 10)}`,
    source: "MINTED" as const,
    reason,
  });

  if (isJunkSerial(input.serial)) {
    return mint(
      input.serial
        ? `it reports "${input.serial}", which is a placeholder rather than an identity`
        : "it reports no serial",
    );
  }
  if (input.duplicatedInScan) {
    return mint("another box in this scan reports the same serial");
  }
  // A box that is already enrolled under this serial is *this* box coming
  // back, not a collision -- re-provisioning it has to keep its row, its name
  // and its history, which only happens if it enrols under the same serial.
  if (input.takenByDevice && !input.alreadyEnrolled) {
    return mint("a different box in the fleet already uses that serial");
  }
  if (input.claimedInFlight && !input.alreadyEnrolled) {
    return mint("another enrollment in flight has already claimed that serial");
  }
  return { resolved: "", source: "REPORTED", reason: "" };
}
