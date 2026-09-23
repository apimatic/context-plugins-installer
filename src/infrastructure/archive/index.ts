import { closeSync } from 'node:fs';

import { sniff, type ArchiveFormat } from '../../types/archive.js';
import { Failure } from '../../types/failure.js';
import type { DirectoryPath, FilePath } from '../../types/file/paths.js';
import { err, ok, type Result } from '../../types/result.js';
import { openFile, readAt, type ArchiveReader } from './reader.js';
import { openTar } from './tar.js';
import { openZip } from './zip.js';

export type { ArchiveReader, Unpacked } from './reader.js';

// One way in, whichever format arrived. The bytes choose the reader rather than
// the name, because a server that gzips a `.tgz` for transport hands us a bare
// tar and a reader picked by extension would refuse a perfectly good archive.

/** Enough for every magic this program knows, the furthest of which is a tar's at 257. */
const HEAD = 512;

const notAnArchive = (describe: string): Failure =>
  new Failure(
    `${describe} is not a zip or a tarball.`,
    'The link may need a login, or may have answered with a web page rather than a file.',
  );

export interface OpenRequest {
  file: FilePath;
  /** How the user named this archive: every failure below here says it back. */
  describe: string;
  /** Somewhere to put a decompressed tarball. Untouched for the other formats. */
  work: DirectoryPath;
}

export function formatOfBytes(file: FilePath, describe: string): Result<ArchiveFormat, Failure> {
  const opened = openFile(file, describe);
  if (!opened.ok) return err(opened.error);
  const { fd, size } = opened.value;
  try {
    const head = readAt(fd, 0, Math.min(size, HEAD));
    const format = sniff(head);
    return format === null ? err(notAnArchive(describe)) : ok(format);
  } finally {
    closeSync(fd);
  }
}

export async function openArchive({
  file,
  describe,
  work,
}: OpenRequest): Promise<Result<ArchiveReader, Failure>> {
  const format = formatOfBytes(file, describe);
  if (!format.ok) return err(format.error);
  if (format.value === 'zip') return openZip(file, describe);
  return openTar({
    file,
    describe,
    unpacked: work.file('unpacked.tar'),
    gzip: format.value === 'tar.gz',
  });
}
