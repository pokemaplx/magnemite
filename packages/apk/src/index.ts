/**
 * What an APK says about itself.
 *
 * An operator uploading a build already has the answer in their hands — the
 * package name and version are inside the file — so asking them to type it
 * again is asking them to make a mistake. This reads it instead.
 *
 * Two formats stand between us and those three strings:
 *
 *   the zip     an APK is one, and an .apkm/.xapk is a zip of APKs
 *   AXML        AndroidManifest.xml is not text but Android's binary XML
 *
 * Neither needs a general-purpose implementation. We want exactly three
 * attributes off the first element, so this reads the zip's central directory
 * for one entry and walks the AXML far enough to find them.
 *
 * Everything here works on a `ByteReader` rather than a whole buffer, because
 * both callers have a reason not to hold the file in memory: the hub is
 * handed a few hundred megabytes on disk, and the dashboard is handed the same
 * thing sitting in a browser tab. Three strings should not cost either of them
 * the whole file.
 */

export type ApkInfo = {
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
  /**
   * Set when the file is not an APK at all but a Cosmog bundle. It has no
   * manifest, so the package is the one below and the version is nobody's to
   * read: `versionName` is whatever the file's own name says, or null.
   */
  cosmog?: boolean;
};

/**
 * What Cosmog is filed under.
 *
 * Cosmog 2 installs no package: it is a binary named after the game, run out
 * of `/data/local/tmp/cos`. But a version, a rollout, a group's MITM and the
 * fleet's version column are all keyed on a package name, so it gets one --
 * and the agent answers for it by reading `cos.version` instead of asking
 * `pm`. The agent's `cosmog.Package` is this same string.
 */
export const COSMOG_PACKAGE = "com.sy1vi3.cosmog";

/** The game, which on a Cosmog box is a library and two APKs, not an app. */
export const GAME_PACKAGE = "com.nianticlabs.pokemongo";

/** What a Cosmog bundle is recognised by: the binary, and the ART it loads. */
export const COSMOG_BINARY = "com.nianticlabs.pokemongo";
export const COSMOG_LIBART = "lib/libart.so";

/**
 * Is this zip a Cosmog bundle?
 *
 * The shape sy1vi3 publishes and aconf's `bundles.sh` unpacks: the binary at
 * the root and `lib/libart.so` beside it. Both, because the binary without its
 * libart does not start, and a bundle missing one is better refused at upload
 * than discovered on forty boxes. A single wrapping directory is allowed --
 * zipping a folder rather than its contents is the commonest way to make one.
 */
export function isCosmogBundle(entries: Pick<ZipEntry, "name">[]): boolean {
  return cosmogPrefix(entries) !== null;
}

/** The directory a Cosmog bundle's files sit under: "" or "something/". Null when it is not one. */
export function cosmogPrefix(entries: Pick<ZipEntry, "name">[]): string | null {
  const names = new Set(entries.map((e) => e.name));
  for (const name of names) {
    if (name !== COSMOG_BINARY && !name.endsWith(`/${COSMOG_BINARY}`)) continue;
    const prefix = name.slice(0, name.length - COSMOG_BINARY.length);
    if (prefix.split("/").length > 2) continue;
    if (names.has(prefix + COSMOG_LIBART)) return prefix;
  }
  return null;
}

/** `2.1.3` out of `cosmog-2.1.3.zip`. Null from `cosmog2.zip`, which says nothing. */
export function versionFromFilename(filename: string): string | null {
  return filename.match(/(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z]+)*?)(?:\.[A-Za-z]+)?$/)?.[1] ?? null;
}

/** Random access to a file, however the host happens to hold it. */
export type ByteReader = {
  size: number;
  /** Bytes `[start, start + length)`. Short reads at EOF are fine. */
  read(start: number, length: number): Promise<Uint8Array>;
};

/** Raw DEFLATE, which Node and the browser each spell differently. */
export type InflateRaw = (data: Uint8Array) => Promise<Uint8Array>;

export const EMPTY_APK_INFO: ApkInfo = {
  packageName: null,
  versionName: null,
  versionCode: null,
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The largest a zip comment can be, and so how far back the EOCD can sit. */
const MAX_COMMENT = 0xffff;

export type ZipEntry = { name: string; compression: number; offset: number; size: number };

const utf8 = new TextDecoder("utf-8");
const utf16 = new TextDecoder("utf-16le");

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A reader over bytes already in hand — a nested archive, or a small file. */
export function bytesReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    read: async (start, length) => bytes.subarray(start, start + length),
  };
}

/**
 * List a zip's entries.
 *
 * The end-of-central-directory record is at the tail, after a comment of up to
 * 64 KB, so the search starts from the end of the file rather than reading
 * forwards through hundreds of megabytes of APK.
 */
export async function readCentralDirectory(reader: ByteReader): Promise<ZipEntry[]> {
  const tailLength = Math.min(reader.size, MAX_COMMENT + 22);
  const tailStart = reader.size - tailLength;
  const tail = await reader.read(tailStart, tailLength);
  const tailView = view(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");

  const count = tailView.getUint16(eocd + 10, true);
  const directorySize = tailView.getUint32(eocd + 12, true);
  const directoryStart = tailView.getUint32(eocd + 16, true);

  // The directory usually falls inside the tail already; only read again when
  // it does not, which is what a zip with many entries looks like.
  const directory =
    directoryStart >= tailStart
      ? tail.subarray(directoryStart - tailStart, directoryStart - tailStart + directorySize)
      : await reader.read(directoryStart, directorySize);
  const directoryView = view(directory);

  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > directory.length) break;
    if (directoryView.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const compression = directoryView.getUint16(offset + 10, true);
    const compressedSize = directoryView.getUint32(offset + 20, true);
    const nameLength = directoryView.getUint16(offset + 28, true);
    const extraLength = directoryView.getUint16(offset + 30, true);
    const commentLength = directoryView.getUint16(offset + 32, true);
    const localOffset = directoryView.getUint32(offset + 42, true);
    const name = utf8.decode(directory.subarray(offset + 46, offset + 46 + nameLength));

    entries.push({ name, compression, offset: localOffset, size: compressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Where an entry's data actually starts, past its own local header. */
async function dataStart(reader: ByteReader, entry: ZipEntry): Promise<number> {
  const header = await reader.read(entry.offset, 30);
  const headerView = view(header);
  if (headerView.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new Error(`${entry.name}: bad local header`);
  }
  // The local header repeats the name and carries its own extra field, whose
  // length differs from the central one often enough to matter.
  const nameLength = headerView.getUint16(26, true);
  const extraLength = headerView.getUint16(28, true);
  return entry.offset + 30 + nameLength + extraLength;
}

/** Pull one entry out, following its local header to the data. */
export async function readEntry(
  reader: ByteReader,
  entry: ZipEntry,
  inflateRaw: InflateRaw,
): Promise<Uint8Array> {
  const start = await dataStart(reader, entry);
  const data = await reader.read(start, entry.size);

  if (entry.compression === 0) return data;
  if (entry.compression === 8) return inflateRaw(data);
  throw new Error(`${entry.name}: unsupported compression ${entry.compression}`);
}

/**
 * A reader over one entry, without pulling it into memory when it is stored.
 *
 * The base split of an .apkm is itself an archive, and it is normally stored
 * rather than deflated — an APK is already compressed. Reading it as a window
 * onto the outer file means a 250 MB bundle costs a handful of small reads
 * instead of 250 MB of memory. A deflated entry has to be inflated whole,
 * which is the rarer and more expensive case.
 */
export async function entryReader(
  reader: ByteReader,
  entry: ZipEntry,
  inflateRaw: InflateRaw,
): Promise<ByteReader> {
  if (entry.compression !== 0) return bytesReader(await readEntry(reader, entry, inflateRaw));

  const start = await dataStart(reader, entry);
  return {
    size: entry.size,
    read: (from, length) => reader.read(start + from, Math.min(length, entry.size - from)),
  };
}

// --- AXML -------------------------------------------------------------------

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_ELEMENT = 0x0102;
const UTF8_FLAG = 1 << 8;

/**
 * Attribute ids from Android's own resource table.
 *
 * A compiled manifest often leaves the name of a framework attribute out of
 * the string pool and identifies it by id instead, through the resource map
 * chunk. Only these two are needed here.
 */
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;

/**
 * The string pool every other chunk indexes into.
 *
 * Strings are either UTF-16 (the original format) or UTF-8 (since Android 4),
 * flagged in the header — and the UTF-8 form writes two lengths, in characters
 * and then in bytes, which is the part everyone gets wrong.
 */
function readStringPool(chunk: Uint8Array): string[] {
  const chunkView = view(chunk);
  const count = chunkView.getUint32(8, true);
  const flags = chunkView.getUint32(16, true);
  const stringsStart = chunkView.getUint32(20, true);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const strings: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = stringsStart + chunkView.getUint32(28 + i * 4, true);
    if (offset >= chunk.length) {
      strings.push("");
      continue;
    }

    if (isUtf8) {
      // Lengths above 0x7f take two bytes, high bit set on the first.
      let cursor = offset;
      cursor += (chunk[cursor]! & 0x80) !== 0 ? 2 : 1; // characters, unused
      const byteLength =
        (chunk[cursor]! & 0x80) !== 0
          ? ((chunk[cursor]! & 0x7f) << 8) | chunk[cursor + 1]!
          : chunk[cursor]!;
      cursor += (chunk[cursor]! & 0x80) !== 0 ? 2 : 1;
      strings.push(utf8.decode(chunk.subarray(cursor, cursor + byteLength)));
    } else {
      const length = chunkView.getUint16(offset, true);
      strings.push(utf16.decode(chunk.subarray(offset + 2, offset + 2 + length * 2)));
    }
  }
  return strings;
}

/** Value types, of which only these three ever appear on what we read. */
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

/**
 * Read `package`, `versionName` and `versionCode` off the manifest element.
 *
 * Only the first start element is needed — `<manifest>` — so the walk stops
 * there rather than building a tree nobody asked for.
 */
export function parseManifest(axml: Uint8Array): ApkInfo {
  const info: ApkInfo = { packageName: null, versionName: null, versionCode: null };
  const axmlView = view(axml);

  let strings: string[] = [];
  let resourceIds: number[] = [];
  let offset = 8; // past the file header

  while (offset + 8 <= axml.length) {
    const type = axmlView.getUint16(offset, true);
    const size = axmlView.getUint32(offset + 4, true);
    if (size <= 0 || offset + size > axml.length) break;

    const chunk = axml.subarray(offset, offset + size);
    const chunkView = view(chunk);

    if (type === CHUNK_STRING_POOL) {
      strings = readStringPool(chunk);
    } else if (type === CHUNK_RESOURCE_MAP) {
      // One resource id per string-pool index, in order.
      resourceIds = [];
      for (let i = 8; i + 4 <= chunk.length; i += 4) resourceIds.push(chunkView.getUint32(i, true));
    } else if (type === CHUNK_START_ELEMENT) {
      // A start element is the 8-byte chunk header, then lineNumber and
      // comment, and only then the attribute block this reads — hence 16.
      const attributeStart = chunkView.getUint16(24, true);
      const attributeSize = chunkView.getUint16(26, true);
      const attributeCount = chunkView.getUint16(28, true);
      const base = 16 + attributeStart;

      for (let i = 0; i < attributeCount; i += 1) {
        const at = base + i * attributeSize;
        if (at + 20 > chunk.length) break;

        const nameIndex = chunkView.getUint32(at + 4, true);
        const rawValue = chunkView.getInt32(at + 8, true);
        const valueType = chunkView.getUint8(at + 15);
        const data = chunkView.getUint32(at + 16, true);

        const name = strings[nameIndex] ?? "";
        const resourceId = resourceIds[nameIndex] ?? 0;

        let value: string | null = null;
        if (valueType === TYPE_STRING) value = strings[rawValue] ?? null;
        else if (valueType === TYPE_INT_DEC || valueType === TYPE_INT_HEX) value = String(data);

        // By name where the pool has one, by resource id where it does not.
        if (name === "package") info.packageName = value;
        else if (name === "versionName" || resourceId === ATTR_VERSION_NAME) {
          info.versionName = value;
        } else if (name === "versionCode" || resourceId === ATTR_VERSION_CODE) {
          info.versionCode = value;
        }
      }

      // <manifest> is the first element; everything after it is application
      // detail we have no use for.
      return info;
    }

    offset += size;
  }

  return info;
}

/** The entry to read, preferring the base split of a multi-APK bundle. */
function pickManifestSource(entries: ZipEntry[]): { manifest?: ZipEntry; apk?: ZipEntry } {
  const manifest = entries.find((e) => e.name === "AndroidManifest.xml");
  if (manifest) return { manifest };

  const apks = entries.filter((e) => e.name.toLowerCase().endsWith(".apk"));
  const base =
    apks.find((e) => /(^|\/)base\.apk$/i.test(e.name)) ??
    // Split names carry a config suffix; anything without one is the base.
    apks.find((e) => !/split_|config\./i.test(e.name)) ??
    apks[0];
  return { apk: base };
}

/**
 * Read what an APK or bundle says about itself. Never throws: a file we cannot
 * make sense of is one the operator deals with by hand, which is what they did
 * before this existed.
 */
export async function readApkInfo(reader: ByteReader, inflateRaw: InflateRaw): Promise<ApkInfo> {
  try {
    const entries = await readCentralDirectory(reader);
    if (isCosmogBundle(entries)) {
      return { packageName: COSMOG_PACKAGE, versionName: null, versionCode: null, cosmog: true };
    }
    const { manifest, apk } = pickManifestSource(entries);

    if (manifest) return parseManifest(await readEntry(reader, manifest, inflateRaw));
    if (!apk) return EMPTY_APK_INFO;

    // A bundle: the manifest is inside the base split.
    const inner = await entryReader(reader, apk, inflateRaw);
    const innerEntries = await readCentralDirectory(inner);
    const innerManifest = innerEntries.find((e) => e.name === "AndroidManifest.xml");
    if (!innerManifest) return EMPTY_APK_INFO;
    return parseManifest(await readEntry(inner, innerManifest, inflateRaw));
  } catch {
    return EMPTY_APK_INFO;
  }
}
