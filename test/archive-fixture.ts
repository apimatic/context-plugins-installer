import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

import { FilePath } from '../src/types/file/paths.js';
import { crc32 } from '../src/infrastructure/archive/zip.js';
import { tmpDir } from './helpers.js';

// Archives written by hand, so the suite can build the ones nobody ships on
// purpose - a name that climbs out, a symlink, a lying checksum, an encrypted
// entry - without a binary fixture in the repository.

export interface ZipEntrySpec {
  name: string;
  data?: string;
  /** Stored by default; `deflate` exercises the other method a zip may use. */
  deflate?: boolean;
  /** Written as a unix mode, which makes the entry host-OS 3. */
  mode?: number;
  /** A symlink entry: a file whose contents are its target. */
  link?: string;
  encrypted?: boolean;
  badCrc?: boolean;
  /** Sizes and offset written as 0xffffffff, with the real ones in an extra field. */
  zip64?: boolean;
  /** A size other than the data's, for the entry that lies about itself. */
  declaredSize?: number;
  /** A compressed size other than the data's - the one the extract reads by. */
  declaredCompressed?: number;
}

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};

const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
};

const u64 = (value: number): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
};

const S_IFLNK = 0o120000;
const MAX32 = 0xffffffff;

/** A zip, written the way the readers expect to find one. */
export function zipOf(
  entries: readonly ZipEntrySpec[],
  options: { zip64Eocd?: boolean } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const name = Buffer.from(spec.name, 'utf8');
    const contents = Buffer.from(spec.link ?? spec.data ?? '', 'utf8');
    const stored = spec.deflate ? deflateRawSync(contents) : contents;
    const size = spec.declaredSize ?? contents.length;
    const crc = spec.badCrc ? 0xdeadbeef : crc32(contents);
    const flags = spec.encrypted ? 0x0001 : 0x0800;
    const method = spec.deflate ? 8 : 0;
    const unix = spec.link ? S_IFLNK | 0o777 : (spec.mode ?? 0);
    const extra = spec.zip64
      ? Buffer.concat([u16(0x0001), u16(24), u64(size), u64(stored.length), u64(offset)])
      : Buffer.alloc(0);
    const shown = (value: number): Buffer => u32(spec.zip64 ? MAX32 : value);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(stored.length),
      u32(size),
      u16(name.length),
      u16(0),
      name,
      stored,
    ]);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(((unix ? 3 : 0) << 8) | 20),
        u16(20),
        u16(flags),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        shown(spec.declaredCompressed ?? stored.length),
        shown(size),
        u16(name.length),
        u16(extra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(unix << 16),
        shown(offset),
        name,
        extra,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const parts = [...locals, central];
  let eocdOffset = offset + central.length;

  if (options.zip64Eocd) {
    const record = Buffer.concat([
      u32(0x06064b50),
      u64(44),
      u16(45),
      u16(45),
      u32(0),
      u32(0),
      u64(entries.length),
      u64(entries.length),
      u64(central.length),
      u64(offset),
    ]);
    const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(eocdOffset), u32(1)]);
    parts.push(record, locator);
    eocdOffset += record.length + locator.length;
  }

  parts.push(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(central.length),
      u32(offset),
      u16(0),
    ]),
  );
  return Buffer.concat(parts);
}

export interface TarEntrySpec {
  name: string;
  data?: string;
  mode?: number;
  /** `0` a file, `5` a directory, `2` a symlink, `1` a hard link, `3` a device. */
  type?: string;
  /** Carry the name in a PAX header instead, the way GitHub writes a long one. */
  pax?: boolean;
  /** Carry it in a GNU long-name header instead. */
  gnuLong?: boolean;
  badChecksum?: boolean;
  /** A size other than the data's, for the header that lies about itself. */
  declaredSize?: number;
}

const BLOCK = 512;

const octal = (value: number, length: number): string =>
  `${value.toString(8).padStart(length - 1, '0')}\0`;

function header(spec: {
  name: string;
  size: number;
  mode: number;
  type: string;
  badChecksum?: boolean;
}): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(spec.name.slice(0, 100), 0, 'utf8');
  block.write(octal(spec.mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(spec.size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(spec.type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${octal(spec.badChecksum ? sum + 1 : sum, 7)} `, 148, 'ascii');
  return block;
}

const padded = (data: Buffer): Buffer => {
  const over = data.length % BLOCK;
  return over === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - over)]);
};

/** A tarball, ustar with the two extensions that carry a long name. */
export function tarOf(entries: readonly TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of entries) {
    const data = Buffer.from(spec.data ?? '', 'utf8');
    const type = spec.type ?? '0';
    const mode = spec.mode ?? 0o644;

    if (spec.pax) {
      const record = `path=${spec.name}\n`;
      const length = `${record.length + 4} `.length + record.length;
      const body = Buffer.from(`${length} ${record}`, 'utf8');
      parts.push(header({ name: 'PaxHeader', size: body.length, mode, type: 'x' }), padded(body));
    } else if (spec.gnuLong) {
      const body = Buffer.from(`${spec.name}\0`, 'utf8');
      parts.push(
        header({ name: '././@LongLink', size: body.length, mode, type: 'L' }),
        padded(body),
      );
    }

    parts.push(
      header({
        name: spec.pax || spec.gnuLong ? 'shortened' : spec.name,
        size: spec.declaredSize ?? data.length,
        mode,
        type,
        badChecksum: spec.badChecksum,
      }),
      padded(data),
    );
  }
  // Two zero blocks end an archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export const gzipOf = (data: Buffer): Buffer => gzipSync(data);

/** An archive on disk, which is the only shape the readers take. */
export function archiveAt(name: string, data: Buffer): FilePath {
  const file = path.join(tmpDir('cp-archive-'), name);
  fs.writeFileSync(file, data);
  return new FilePath(file);
}
