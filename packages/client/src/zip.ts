// The files inside a ZIP archive, as GENESIS's `data/*file` endpoints deliver every download.
// Dependency-free (node:zlib): read through the central directory, each entry stored or
// deflated, its size bounded before it is inflated (a small archive can inflate to gigabytes).
// Not a general ZIP library: no ZIP64, no encryption, no multi-part archives; anything else is a
// RegionalstatistikParseError that says so.

import { inflateRawSync } from "node:zlib";
import { RegionalstatistikParseError } from "./errors.js";

/** One file of an archive: its name and its bytes. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** The end record is 22 bytes, followed by a comment of at most 65535. */
const MAX_END_SEARCH = 22 + 0xffff;
/** More entries than a GENESIS download ever holds (one file, at most a few). */
const MAX_ENTRIES = 64;

/** True for a ZIP file's local-header or empty-archive signature. */
export function isZip(data: Buffer): boolean {
  return data.length >= 4 && (data.readUInt32LE(0) === LOCAL_HEADER || data.readUInt32LE(0) === END_OF_CENTRAL_DIRECTORY);
}

/** One file of an archive, listed but not yet unpacked: `read()` unpacks it (and checks it against the cap). */
export interface ZipListing {
  name: string;
  read(): Buffer;
}

/**
 * The files of the archive `data`, each at most `maxEntryBytes` once unpacked (default 32 MiB):
 * a larger one is a RegionalstatistikParseError naming the cap, never a partial file.
 */
export function readZip(data: Buffer, maxEntryBytes = 32 * 1024 * 1024): ZipEntry[] {
  return zipEntries(data, maxEntryBytes).map((entry) => ({ name: entry.name, data: entry.read() }));
}

/**
 * The files of the archive `data` by name, read through its central directory; none is unpacked
 * until its `read()` is called, so a caller that wants one file (getFlatTable's CSV) never inflates
 * the others: a small archive of many large entries would otherwise hold gigabytes. `read()`
 * refuses a file over `maxEntryBytes` unpacked (default 32 MiB) with a RegionalstatistikParseError
 * naming the cap. The directory itself (its bounds, the entry count, encryption, a local header
 * for each file) is checked when listing.
 */
export function zipEntries(data: Buffer, maxEntryBytes = 32 * 1024 * 1024): ZipListing[] {
  const bad = (why: string): RegionalstatistikParseError => new RegionalstatistikParseError(`The download is not a ZIP archive this client can read: ${why}.`);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - MAX_END_SEARCH); i -= 1) {
    if (data.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw bad("no end of central directory");
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  const offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw bad("a ZIP64 archive");
  if (count > MAX_ENTRIES) throw bad(`${count} files`);
  if (offset + size > end) throw bad("the central directory lies outside the archive");
  const entries: ZipListing[] = [];
  let at = offset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > end || data.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) throw bad("a broken central directory");
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressedSize = data.readUInt32LE(at + 20);
    const uncompressedSize = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const localOffset = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0) throw bad(`${name} is encrypted`);
    if (name.endsWith("/")) continue;
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== LOCAL_HEADER) throw bad(`no local header for ${name}`);
    const read = (): Buffer => {
      if (uncompressedSize > maxEntryBytes) {
        throw new RegionalstatistikParseError(`The download's file ${name} is ${uncompressedSize} bytes unpacked, more than this client reads (${maxEntryBytes}).`);
      }
      const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
      const packed = data.subarray(start, start + compressedSize);
      if (packed.length !== compressedSize) throw bad(`${name} is cut off`);
      let unpacked: Buffer;
      if (method === 0) unpacked = Buffer.from(packed);
      else if (method === 8) {
        try {
          unpacked = inflateRawSync(packed, { maxOutputLength: maxEntryBytes });
        } catch (err) {
          throw bad(`${name} does not inflate (${err instanceof Error ? err.message : String(err)})`);
        }
      } else throw bad(`${name} uses compression method ${method}`);
      if (unpacked.length !== uncompressedSize) throw bad(`${name} unpacks to ${unpacked.length} bytes, not the ${uncompressedSize} it declares`);
      return unpacked;
    };
    entries.push({ name, read });
  }
  return entries;
}
