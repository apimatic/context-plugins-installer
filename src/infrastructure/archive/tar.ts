import { closeSync, createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

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

// A tarball, read from its head: 512-byte headers, each followed by its file
// rounded up to the next block. Gzipped, it is decompressed into the workspace
// first - counted on the way through, because unlike a zip a tarball declares
// no total and a bomb is only visible as it arrives.

const BLOCK = 512;

/** A name or a PAX record past this is not one; the rest is not read. */
const MAX_HEADER_BODY = 64 * 1024;

const REGULAR = new Set(['0', '\0']);
const DIRECTORY = '5';
const SYMLINK = '2';
const HARD_LINK = '1';
const LONG_NAME = 'L';
const LONG_LINK = 'K';
const PAX = new Set(['x', 'g']);

const text = (block: Buffer, at: number, length: number): string => {
  const end = block.indexOf(0, at);
  const stop = end === -1 || end > at + length ? at + length : end;
  return block.toString('utf8', at, stop);
};

/**
 * A tar number is octal in ASCII - except when it does not fit, where GNU sets
 * the top bit of the first byte and writes big-endian binary instead.
 */
function numeric(block: Buffer, at: number, length: number): number {
  if (((block[at] as number) & 0x80) !== 0) {
    let value = 0n;
    for (let i = at + 1; i < at + length; i++) value = (value << 8n) | BigInt(block[i] as number);
    return Number(value & 0x7fffffffffffffffn);
  }
  const digits = text(block, at, length).trim();
  const parsed = Number.parseInt(digits, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Both sums writers have used for the header checksum: the field itself counts
 * as spaces, and some old writers treated the bytes as signed.
 */
function checksums(block: Buffer): { signed: number; unsigned: number } {
  let signed = 0;
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 32 : (block[i] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return { signed, unsigned };
}

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

/** PAX records are `<length> key=value\n`, and `path` is the one that matters here. */
function paxPath(body: Buffer): string | null {
  const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
  return found?.[1] ?? null;
}

interface TarEntry extends ArchiveFile {
  offset: number;
}

interface Walked {
  files: TarEntry[];
  links: string[];
}

function walk(fd: number, size: number, describe: string): Result<Walked, Failure> {
  const names = new EntryNames();
  const files: TarEntry[] = [];
  const links: string[] = [];
  let unpacked = 0;
  let at = 0;
  let longName: string | null = null;
  let paxName: string | null = null;

  while (at + BLOCK <= size) {
    const header = readAt(fd, at, BLOCK);
    if (header.length < BLOCK) return err(damaged(describe, 'it ends inside a header'));
    if (isZeroBlock(header)) break;

    const declared = numeric(header, 148, 8);
    const sums = checksums(header);
    if (declared !== sums.unsigned && declared !== sums.signed) {
      return err(damaged(describe, `the header at byte ${at} failed its checksum`));
    }
    const entrySize = numeric(header, 124, 12);
    const type = String.fromCharCode(header[156] as number);
    const prefix = text(header, 345, 155);
    const stored = text(header, 0, 100);
    const offset = at + BLOCK;
    at = offset + Math.ceil(entrySize / BLOCK) * BLOCK;
    // Only the three header kinds below are read here; a file's own bytes are
    // read when it is written, one entry at a time.
    const body = (): Buffer => readAt(fd, offset, Math.min(entrySize, MAX_HEADER_BODY));

    // Three ways a tarball says "the name is longer than a header holds". Each
    // is a header of its own, carrying the name for the entry that follows.
    if (type === LONG_NAME) {
      longName = body().toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === LONG_LINK) continue;
    if (PAX.has(type)) {
      paxName = paxPath(body()) ?? paxName;
      continue;
    }

    const raw = paxName ?? longName ?? (prefix ? `${prefix}/${stored}` : stored);
    longName = null;
    paxName = null;

    const read = names.read(raw);
    if (read.kind === 'refuse') return err(refused(describe, raw, read.why));
    if (read.kind === 'ignore') continue;

    // A hard link is a link too: `tar` writes one for a file that appears
    // twice, and it is skipped and named the way a symlink is rather than
    // failing the archive.
    if (type === SYMLINK || type === HARD_LINK) {
      links.push(read.name);
      continue;
    }
    if (type === DIRECTORY) continue;
    if (!REGULAR.has(type)) {
      return err(
        damaged(
          describe,
          `${JSON.stringify(read.name)} is an entry of type '${type}', which is not a plugin's file`,
        ),
      );
    }

    if (files.length >= LIMITS.entries) {
      return err(tooMuch(describe, 'holds too many files', files.length + 1, LIMITS.entries));
    }
    unpacked += entrySize;
    if (unpacked > LIMITS.unpacked) {
      return err(tooMuch(describe, 'unpacks to more than it may', unpacked, LIMITS.unpacked));
    }
    const mode = numeric(header, 100, 8) & 0o777;
    files.push({ name: read.name, size: entrySize, mode: mode || null, offset });
  }
  return ok({ files, links });
}

/** Told apart from an I/O error by its message, which is all a stream carries. */
const OVER_CAP = 'context-plugins: past the unpacked limit';

/** Counts what passes, and stops the stream the moment there is too much of it. */
function capped(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) {
        done(new Error(OVER_CAP));
        return;
      }
      done(null, chunk);
    },
  });
}

/**
 * Decompresses into the workspace rather than into memory: the cap is a
 * gigabyte, and a gigabyte of Buffer is an out-of-memory where a gigabyte of
 * file is a disk this machine either has or does not.
 */
async function gunzipTo(
  from: FilePath,
  to: FilePath,
  describe: string,
): Promise<Result<void, Failure>> {
  try {
    await pipeline(
      createReadStream(from.toString()),
      createGunzip(),
      capped(LIMITS.unpacked),
      createWriteStream(to.toString()),
    );
    return ok(undefined);
  } catch (e) {
    const why = errorMessage(e);
    return err(
      why.includes(OVER_CAP)
        ? tooMuch(describe, 'unpacks to more than it may', LIMITS.unpacked, LIMITS.unpacked)
        : damaged(describe, `it did not decompress (${why})`),
    );
  }
}

export interface OpenTarRequest {
  file: FilePath;
  describe: string;
  /** Where a gzipped tarball is decompressed to; unused for a plain one. */
  unpacked: FilePath;
  gzip: boolean;
}

export async function openTar({
  file,
  describe,
  unpacked,
  gzip,
}: OpenTarRequest): Promise<Result<ArchiveReader, Failure>> {
  let source = file;
  if (gzip) {
    const done = await gunzipTo(file, unpacked, describe);
    if (!done.ok) return err(done.error);
    source = unpacked;
  }

  const opened = openFile(source, describe);
  if (!opened.ok) return err(opened.error);
  const { fd, size } = opened.value;
  const close = (): void => {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  };

  const walked = walk(fd, size, describe);
  if (!walked.ok) {
    close();
    return err(walked.error);
  }
  const { files, links } = walked.value;

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
        // Guarded for the same reason the zip's read is: a disk that filled is
        // not something this layer may throw about.
        let data: Buffer;
        try {
          data = readAt(fd, entry.offset, entry.size);
        } catch (e) {
          return err(damaged(describe, errorMessage(e)));
        }
        if (data.length < entry.size) {
          return err(damaged(describe, `${JSON.stringify(entry.name)} is truncated`));
        }
        const put = unpacker.write(relativeTo(entry.name, prefix), data, entry.mode);
        if (!put.ok) return err(put.error);
        written++;
        bytes += data.length;
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
