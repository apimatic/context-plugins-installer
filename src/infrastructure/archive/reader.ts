import * as fs from 'node:fs';

import { Failure } from '../../types/failure.js';
import type { DirectoryPath, FilePath } from '../../types/file/paths.js';
import { err, ok, type Result } from '../../types/result.js';
import { errorMessage } from '../../types/util.js';
import { ensureDir } from '../file-system.js';

// What both readers are, and the handful of things both of them do. A zip is
// read from its tail and a tarball from its head, but each is a file on disk
// answering the same two questions - what is in you, and put this part of it
// there - so everything above them is format-blind.

export interface Unpacked {
  files: number;
  bytes: number;
  /** Named, up to a few: a listing is for a person, not a log. */
  skipped: readonly string[];
  skippedCount: number;
}

export interface ArchiveReader {
  /**
   * Every file the archive holds, by name, relative to its own root. Files
   * only: a directory entry writes nothing, and half the archives in the world
   * carry none at all, so the shape of the tree is read from these.
   */
  names(): readonly string[];
  /** Everything under `prefix`, written into `dest` with the prefix taken off. */
  extract(prefix: string, dest: DirectoryPath): Result<Unpacked, Failure>;
  close(): void;
}

/** One entry, after its name has passed `EntryNames` and its type is known. */
export interface ArchiveFile {
  name: string;
  size: number;
  /** The unix mode the archive carries, or null when it carries none. */
  mode: number | null;
}

export const damaged = (describe: string, why: string): Failure =>
  new Failure(
    `${describe} could not be read: ${why}.`,
    'The download may be incomplete, or the file may not be the archive it is named after.',
  );

export const refused = (describe: string, name: string, why: string): Failure =>
  new Failure(
    `${describe} holds an entry with ${why}: ${JSON.stringify(name)}.`,
    'Nothing was written. An archive that names a file this way is not one this tool will unpack.',
  );

export const tooMuch = (describe: string, what: string, count: number, limit: number): Failure =>
  new Failure(
    `${describe} ${what} (${count.toLocaleString('en-US')}, and the limit is ${limit.toLocaleString('en-US')}).`,
    'This is far larger than a plugin, so it is refused before anything is unpacked.',
  );

export interface OpenFile {
  fd: number;
  size: number;
}

export function openFile(file: FilePath, describe: string): Result<OpenFile, Failure> {
  try {
    const fd = fs.openSync(file.toString(), 'r');
    try {
      return ok({ fd, size: fs.fstatSync(fd).size });
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  } catch (e) {
    return err(damaged(describe, errorMessage(e)));
  }
}

/** Bytes at a position, however few the file actually had there. */
export function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : buffer.subarray(0, read);
}

/**
 * Writes one file of an unpacked archive. The mode is applied only where it
 * means anything: a GitHub zipball carries none at all, so the default is what
 * most plugins from one will get.
 */
export class Unpacker {
  private readonly made = new Set<string>();

  constructor(private readonly dest: DirectoryPath) {}

  write(relative: string, data: Buffer, mode: number | null): Result<void, Failure> {
    const target = this.dest.file(...relative.split('/'));
    // A name out of an archive does not get to say where we write, however it
    // passed the rules on the way here.
    if (!this.dest.contains(target)) {
      return err(new Failure(`Refusing to write outside the destination: ${relative}`));
    }
    const parent = target.parent().toString();
    try {
      // Inside the guard: an archive holding `a` as a file and `a/b` as another
      // fails the mkdir, and that is the archive's fault to report.
      if (!this.made.has(parent)) {
        ensureDir(parent);
        this.made.add(parent);
      }
      fs.writeFileSync(target.toString(), data);
      const bits = mode === null ? 0 : mode & 0o777;
      if (bits && process.platform !== 'win32') fs.chmodSync(target.toString(), bits);
    } catch (e) {
      return err(new Failure(`Could not write ${target}: ${errorMessage(e)}`));
    }
    return ok(undefined);
  }
}

/** Enough names to recognise what was dropped, and a count for the rest. */
export const SKIPPED_SHOWN = 5;
