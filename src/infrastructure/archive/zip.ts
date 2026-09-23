import { closeSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { EntryNames, LIMITS, relativeTo, under } from '../../types/archive.js';
import type { Failure } from '../../types/failure.js';
import type { DirectoryPath, FilePath } from '../../types/file/paths.js';
import { err, ok, type Result } from '../../types/result.js';
import { errorMessage } from '../../types/util.js';
import {
  damaged,
  openFile,
  readAt,
  refused,
  tooMuch,
  Unpacker,
  SKIPPED_SHOWN,
  type ArchiveFile,
  type ArchiveReader,
  type Unpacked,
} from './reader.js';

// A zip, read from its tail: the end-of-central-directory record, then the
// central directory, then one entry at a time through a positioned read. The
// archive is never held in memory - only whichever entry is being written.

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const EOCD_SIZE = 22;
/** The comment that can follow it is a 16-bit length, so this is the whole span. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff;

/** A central directory past this is not a plugin's, whatever it claims. */
const MAX_CENTRAL = 64 * 1024 * 1024;

const ENCRYPTED = 0x0001;
const UTF8_NAMES = 0x0800;

const STORED = 0;
const DEFLATED = 8;

const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * `zlib.crc32` would do this, and lands in Node 20.15. Node 18 is the engine
 * floor, so here is the table - the third thing this package hand-rolls rather
 * than take a dependency for.
 */
const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = (TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface ZipEntry extends ArchiveFile {
  compressed: number;
  method: number;
  crc: number;
  local: number;
}

function findEocd(fd: number, size: number): number | null {
  const span = Math.min(size, EOCD_SEARCH);
  const tail = readAt(fd, size - span, span);
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) return size - span + i;
  }
  return null;
}

interface Directory {
  entries: number;
  size: number;
  offset: number;
}

function readEocd(fd: number, size: number, describe: string): Result<Directory, Failure> {
  const at = findEocd(fd, size);
  if (at === null) return err(damaged(describe, 'it has no end-of-central-directory record'));
  const eocd = readAt(fd, at, EOCD_SIZE);
  if (eocd.length < EOCD_SIZE) return err(damaged(describe, 'its directory record is truncated'));

  let found: Directory = {
    entries: eocd.readUInt16LE(10),
    size: eocd.readUInt32LE(12),
    offset: eocd.readUInt32LE(16),
  };

  // Zip64, whose locator sits immediately before the record above. No plugin
  // needs it; a writer that emits it anyway is not a reason to fail.
  if (at >= 20) {
    const locator = readAt(fd, at - 20, 20);
    if (locator.length === 20 && locator.readUInt32LE(0) === EOCD64_LOCATOR) {
      const record = Number(locator.readBigUInt64LE(8));
      // Checked before the read: a pointer past the file is a malformed archive
      // to report, and one past the safe-integer range is one `readSync` throws on.
      const zip64 =
        Number.isSafeInteger(record) && record + 56 <= at ? readAt(fd, record, 56) : null;
      if (zip64 === null || zip64.readUInt32LE(0) !== EOCD64) {
        return err(damaged(describe, 'its zip64 directory record is missing'));
      }
      found = {
        entries: Number(zip64.readBigUInt64LE(32)),
        size: Number(zip64.readBigUInt64LE(40)),
        offset: Number(zip64.readBigUInt64LE(48)),
      };
    }
  }

  if (found.offset + found.size > size) {
    return err(damaged(describe, 'its directory runs past the end of the file'));
  }
  if (found.size > MAX_CENTRAL) {
    return err(damaged(describe, 'its directory is implausibly large'));
  }
  return ok(found);
}

/** Zip64 puts whatever did not fit in 32 bits in an extra field, in this order. */
function zip64Extra(
  extra: Buffer,
  entry: { size: number; compressed: number; local: number },
): void {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    let value = at + 4;
    if (id === 0x0001) {
      const next = (): number => {
        const read = Number(extra.readBigUInt64LE(value));
        value += 8;
        return read;
      };
      if (entry.size === 0xffffffff && value + 8 <= extra.length) entry.size = next();
      if (entry.compressed === 0xffffffff && value + 8 <= extra.length) entry.compressed = next();
      if (entry.local === 0xffffffff && value + 8 <= extra.length) entry.local = next();
      return;
    }
    at += 4 + length;
  }
}

interface Central {
  files: ZipEntry[];
  links: string[];
}

function readCentral(fd: number, directory: Directory, describe: string): Result<Central, Failure> {
  if (directory.entries > LIMITS.entries) {
    return err(tooMuch(describe, 'holds too many files', directory.entries, LIMITS.entries));
  }
  const buffer = readAt(fd, directory.offset, directory.size);
  const names = new EntryNames();
  const files: ZipEntry[] = [];
  const links: string[] = [];
  let unpacked = 0;
  let at = 0;

  for (let i = 0; i < directory.entries; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) {
      return err(damaged(describe, `its directory entry ${i + 1} is not readable`));
    }
    const madeBy = buffer.readUInt16LE(at + 4);
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const external = buffer.readUInt32LE(at + 38);
    const sizes = {
      compressed: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      local: buffer.readUInt32LE(at + 42),
    };
    const nameAt = at + 46;
    // Bit 11 is the only promise a zip makes about its encoding; without it the
    // bytes are whatever the writer's machine used, and latin1 at least
    // round-trips them.
    const raw = buffer.toString(
      flags & UTF8_NAMES ? 'utf8' : 'latin1',
      nameAt,
      nameAt + nameLength,
    );
    zip64Extra(buffer.subarray(nameAt + nameLength, nameAt + nameLength + extraLength), sizes);
    at = nameAt + nameLength + extraLength + commentLength;

    const read = names.read(raw);
    if (read.kind === 'refuse') return err(refused(describe, raw, read.why));
    if (read.kind === 'ignore') continue;

    if (flags & ENCRYPTED) {
      return err(
        damaged(
          describe,
          `${JSON.stringify(read.name)} is encrypted, and this tool has no password`,
        ),
      );
    }
    const mode = madeBy >> 8 === UNIX ? (external >>> 16) & 0xffff : 0;
    // A zip stores a symlink as a file whose contents are its target.
    if ((mode & S_IFMT) === S_IFLNK) {
      links.push(read.name);
      continue;
    }
    // A directory entry writes nothing: the tree is read from the file names,
    // and every parent is created by the write that needs it.
    if (raw.endsWith('/') || raw.endsWith('\\')) continue;

    if (method !== STORED && method !== DEFLATED) {
      return err(
        damaged(describe, `${JSON.stringify(read.name)} uses compression method ${method}`),
      );
    }
    unpacked += sizes.size;
    if (unpacked > LIMITS.unpacked) {
      return err(tooMuch(describe, 'unpacks to more than it may', unpacked, LIMITS.unpacked));
    }
    files.push({
      name: read.name,
      size: sizes.size,
      mode: mode & 0o777 ? mode & 0o777 : null,
      compressed: sizes.compressed,
      method,
      crc,
      local: sizes.local,
    });
  }
  return ok({ files, links });
}

function contentsOf(fd: number, entry: ZipEntry, describe: string): Result<Buffer, Failure> {
  const header = readAt(fd, entry.local, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) {
    return err(damaged(describe, `${JSON.stringify(entry.name)} has no local header`));
  }
  // The local header's own lengths, which differ from the central directory's
  // often enough that reading the central ones is a bug that works most days.
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const start = entry.local + 30 + nameLength + extraLength;
  const raw = readAt(fd, start, entry.compressed);
  if (raw.length < entry.compressed) {
    return err(damaged(describe, `${JSON.stringify(entry.name)} is truncated`));
  }

  let data: Buffer;
  try {
    // Bounded by what the entry declared, so a lying header fails here rather
    // than allocating whatever it asked for. Never below one: zlib refuses a
    // bound of zero, and an empty file deflated - which Python's zipfile and
    // Java both write - would fail the whole archive over two bytes.
    data =
      entry.method === STORED
        ? raw
        : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
  } catch (e) {
    return err(
      damaged(describe, `${JSON.stringify(entry.name)} did not decompress (${errorMessage(e)})`),
    );
  }
  if (data.length !== entry.size) {
    return err(damaged(describe, `${JSON.stringify(entry.name)} is not the size it declared`));
  }
  if (crc32(data) !== entry.crc) {
    return err(damaged(describe, `${JSON.stringify(entry.name)} failed its checksum`));
  }
  return ok(data);
}

export function openZip(file: FilePath, describe: string): Result<ArchiveReader, Failure> {
  const opened = openFile(file, describe);
  if (!opened.ok) return err(opened.error);
  const { fd, size } = opened.value;
  const close = (): void => {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  };

  const directory = readEocd(fd, size, describe);
  if (!directory.ok) {
    close();
    return err(directory.error);
  }
  const central = readCentral(fd, directory.value, describe);
  if (!central.ok) {
    close();
    return err(central.error);
  }
  const { files, links } = central.value;

  return ok({
    names: () => files.map((entry) => entry.name),
    close,
    extract(prefix, dest: DirectoryPath): Result<Unpacked, Failure> {
      const unpacker = new Unpacker(dest);
      const skipped = links.filter((name) => under(name, prefix));
      let written = 0;
      let bytes = 0;
      for (const entry of files) {
        if (!under(entry.name, prefix)) continue;
        // A read can fail for reasons the archive is innocent of - a disk that
        // filled, a file that went away - and this is infrastructure, which
        // answers rather than throws.
        let data: Result<Buffer, Failure>;
        try {
          data = contentsOf(fd, entry, describe);
        } catch (e) {
          return err(damaged(describe, errorMessage(e)));
        }
        if (!data.ok) return err(data.error);
        const put = unpacker.write(relativeTo(entry.name, prefix), data.value, entry.mode);
        if (!put.ok) return err(put.error);
        written++;
        bytes += data.value.length;
      }
      return ok({
        files: written,
        bytes,
        skipped: skipped.slice(0, SKIPPED_SHOWN),
        skippedCount: skipped.length,
      });
    },
  });
}
