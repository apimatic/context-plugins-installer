import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { downloadArchive } from '../../src/infrastructure/archive/download.js';
import { openArchive } from '../../src/infrastructure/archive/index.js';
import type { ArchiveReader } from '../../src/infrastructure/archive/index.js';
import { openArchive as openThroughFetcher } from '../../src/infrastructure/source-fetcher.js';
import { DirectoryPath, FilePath } from '../../src/types/file/paths.js';
import type { Failure } from '../../src/types/failure.js';
import type { FetchLike } from '../../src/types/ports.js';
import type { Result } from '../../src/types/result.js';
import { archiveAt, gzipOf, tarOf, zipOf } from '../archive-fixture.js';
import { cleanupAll, portsFor, stubFetch, tmpDir } from '../helpers.js';

test.after(cleanupAll);

// Both readers over archives built in the test, including the ones nobody
// ships on purpose. Every guard the plan lists has a case here.

const MANIFEST = '.claude-plugin/plugin.json';
const manifest = '{"name":"my-plugin","description":"d"}';

const workspace = (): DirectoryPath => new DirectoryPath(tmpDir('cp-work-'));

const open = (file: ReturnType<typeof archiveAt>, describe = 'my-plugin.zip') =>
  openArchive({ file, describe, work: workspace() });

const reader = async (result: Promise<Result<ArchiveReader, Failure>>): Promise<ArchiveReader> => {
  const opened = await result;
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message);
  return opened.value;
};

const failed = async (result: Promise<Result<ArchiveReader, Failure>>): Promise<Failure> => {
  const opened = await result;
  assert.ok(!opened.ok, 'expected a failure');
  return opened.error;
};

const into = (): DirectoryPath => new DirectoryPath(path.join(tmpDir('cp-out-'), 'files'));

const read = (dest: DirectoryPath, ...parts: string[]): string =>
  fs.readFileSync(dest.file(...parts).toString(), 'utf8');

const plugin = [
  { name: MANIFEST, data: manifest },
  { name: 'skills/SKILL.md', data: '# a skill', deflate: true },
];

test('a zip is read and written out, whichever method its entries used', async () => {
  const opened = await reader(open(archiveAt('p.zip', zipOf(plugin))));
  assert.deepEqual([...opened.names()], [MANIFEST, 'skills/SKILL.md']);

  const dest = into();
  const out = opened.extract('', dest);
  assert.ok(out.ok, out.ok ? '' : out.error.message);
  assert.equal(out.value.files, 2);
  assert.equal(read(dest, ...MANIFEST.split('/')), manifest);
  assert.equal(read(dest, 'skills', 'SKILL.md'), '# a skill');
  opened.close();
});

test('an empty file that was deflated rather than stored is still a file', async () => {
  // Python's zipfile and Java's ZipOutputStream both deflate an empty entry to
  // two bytes; a bound of zero on the inflate refused every archive with a
  // `.gitkeep` in it.
  const entries = [...plugin, { name: 'hooks/.gitkeep', data: '', deflate: true }];
  const opened = await reader(open(archiveAt('p.zip', zipOf(entries))));
  const dest = into();
  const out = opened.extract('', dest);
  assert.ok(out.ok, out.ok ? '' : out.error.message);
  assert.equal(out.value.files, 3);
  assert.equal(read(dest, 'hooks', '.gitkeep'), '');
  opened.close();
});

test('a tarball made of the current directory carries ./ on every name, and installs', async () => {
  // `tar -czf plugin.tgz .` - GNU tar 1.35 writes `./`, `./.claude-plugin/`,
  // `./.claude-plugin/plugin.json`. The dot says nothing and is dropped.
  const entries = [
    { name: './', type: '5' },
    { name: './.claude-plugin/', type: '5' },
    { name: `./${MANIFEST}`, data: manifest },
    { name: './skills/SKILL.md', data: '# a skill' },
  ];
  const opened = await reader(open(archiveAt('p.tar', tarOf(entries)), 'p.tar'));
  assert.deepEqual([...opened.names()], [MANIFEST, 'skills/SKILL.md']);
  const dest = into();
  const out = opened.extract('', dest);
  assert.ok(out.ok, out.ok ? '' : out.error.message);
  assert.equal(read(dest, 'skills', 'SKILL.md'), '# a skill');
  opened.close();
});

test('a tarball is read the same way, through the same interface', async () => {
  const file = archiveAt('p.tar', tarOf(plugin));
  const opened = await reader(open(file, 'p.tar'));
  assert.deepEqual([...opened.names()], [MANIFEST, 'skills/SKILL.md']);

  const dest = into();
  assert.ok(opened.extract('', dest).ok);
  assert.equal(read(dest, 'skills', 'SKILL.md'), '# a skill');
  opened.close();
});

test('a gzipped tarball is decompressed into the workspace first', async () => {
  const file = archiveAt('p.tar.gz', gzipOf(tarOf(plugin)));
  const opened = await reader(open(file, 'p.tar.gz'));
  const dest = into();
  assert.ok(opened.extract('', dest).ok);
  assert.equal(read(dest, ...MANIFEST.split('/')), manifest);
  opened.close();
});

test('the bytes pick the reader, not the name it arrived under', async () => {
  // A `.tgz` served with Content-Encoding: gzip arrives as a bare tar.
  const file = archiveAt('p.tgz', tarOf(plugin));
  const opened = await reader(open(file, 'p.tgz'));
  assert.deepEqual([...opened.names()], [MANIFEST, 'skills/SKILL.md']);
  opened.close();
});

test('only what is under the prefix is written, with the prefix taken off', async () => {
  const entries = [
    { name: 'wrap/README.md', data: 'read me' },
    { name: `wrap/tools/foo/${MANIFEST}`, data: manifest },
    { name: 'wrap/tools/bar/x.txt', data: 'not this' },
  ];
  const opened = await reader(open(archiveAt('mono.zip', zipOf(entries))));
  const dest = into();
  const out = opened.extract('wrap/tools/foo', dest);
  assert.ok(out.ok, out.ok ? '' : out.error.message);
  assert.equal(out.value.files, 1);
  assert.equal(read(dest, ...MANIFEST.split('/')), manifest);
  assert.equal(fs.existsSync(dest.file('x.txt').toString()), false);
  opened.close();
});

test('a directory entry writes nothing and is not a file', async () => {
  const entries = [{ name: 'skills/' }, { name: 'skills/SKILL.md', data: '# a skill' }];
  const opened = await reader(open(archiveAt('p.zip', zipOf(entries))));
  assert.deepEqual([...opened.names()], ['skills/SKILL.md'], 'directories are not files');
  const dest = into();
  const out = opened.extract('', dest);
  assert.ok(out.ok && out.value.files === 1);
  opened.close();
});

test('a name that climbs out of the archive ends it, and nothing is written', async () => {
  const err = await failed(
    open(archiveAt('p.zip', zipOf([{ name: '../../.bashrc', data: 'owned' }]))),
  );
  assert.match(err.message, /climbs out/);
  assert.match(err.hint ?? '', /Nothing was written/);
});

test('an absolute name ends it too, in a tarball as much as in a zip', async () => {
  const err = await failed(
    open(archiveAt('p.tar', tarOf([{ name: '/etc/cron.d/x', data: 'owned' }])), 'p.tar'),
  );
  assert.match(err.message, /absolute path/);
});

test('a symlink is dropped rather than followed, and the rest still installs', async () => {
  const entries = [
    { name: MANIFEST, data: manifest },
    { name: 'escape', link: '/etc/passwd' },
  ];
  const opened = await reader(open(archiveAt('p.zip', zipOf(entries))));
  assert.deepEqual([...opened.names()], [MANIFEST], 'a link is not a file to write');

  const dest = into();
  const out = opened.extract('', dest);
  assert.ok(out.ok, out.ok ? '' : out.error.message);
  assert.deepEqual([...out.value.skipped], ['escape']);
  assert.equal(out.value.skippedCount, 1);
  assert.equal(fs.existsSync(dest.file('escape').toString()), false);
  opened.close();
});

test('a tarballs symlink is dropped by its type', async () => {
  const entries = [
    { name: MANIFEST, data: manifest },
    { name: 'escape', type: '2' },
  ];
  const opened = await reader(open(archiveAt('p.tar', tarOf(entries)), 'p.tar'));
  const dest = into();
  const out = opened.extract('', dest);
  assert.ok(out.ok && out.value.skippedCount === 1);
  opened.close();
});

test('an entry that claims more bytes than the archive holds is refused, not allocated', async () => {
  // Both readers used to hand the declared length straight to Buffer.alloc: a
  // three-kilobyte file asking for a gigabyte got one, and only then failed for
  // being truncated. The file's own size is the bound, and it is known here.
  const zip = zipOf([
    { name: MANIFEST, data: manifest },
    { name: 'big.txt', data: 'hello', declaredCompressed: 0x60000000 },
  ]);
  const zipErr = await failed(open(archiveAt('p.zip', zip)));
  assert.match(zipErr.message, /claims more bytes than the file holds/);

  const tar = tarOf([
    { name: MANIFEST, data: manifest },
    { name: 'big.txt', data: 'hello', declaredSize: 0x40000000 },
  ]);
  const tarErr = await failed(open(archiveAt('p.tar', tar), 'p.tar'));
  assert.match(tarErr.message, /runs past the end of the file/);
});

test('a hard link is a link: skipped and named, like a symlink', async () => {
  const entries = [
    { name: MANIFEST, data: manifest },
    { name: 'twin', type: '1' },
  ];
  const opened = await reader(open(archiveAt('p.tar', tarOf(entries)), 'p.tar'));
  const out = opened.extract('', into());
  assert.ok(out.ok && out.value.skippedCount === 1 && out.value.skipped[0] === 'twin');
  opened.close();
});

test('a device node is refused by name, not quietly skipped', async () => {
  const err = await failed(
    open(archiveAt('p.tar', tarOf([{ name: 'odd', type: '3', data: '' }])), 'p.tar'),
  );
  assert.match(err.message, /not a plugin's file/);
});

test('a file where a directory is needed fails the extraction rather than throwing', async () => {
  // `a` is a file and `a/b` wants `a` to be a directory: the mkdir fails, and
  // that is a Failure about the archive, not a stack trace.
  const entries = [
    { name: MANIFEST, data: manifest },
    { name: 'a', data: 'file' },
    { name: 'a/b', data: 'under it' },
  ];
  const opened = await reader(open(archiveAt('p.zip', zipOf(entries))));
  const out = opened.extract('', into());
  assert.ok(!out.ok, 'expected a failure');
  assert.match(out.error.message, /Could not write/);
  opened.close();
});

test('an encrypted entry says so rather than reading as corrupt', async () => {
  const err = await failed(
    open(archiveAt('p.zip', zipOf([{ name: 'secret.txt', data: 'x', encrypted: true }]))),
  );
  assert.match(err.message, /encrypted/);
});

test('a checksum that does not match the bytes fails the extraction', async () => {
  const opened = await reader(
    open(archiveAt('p.zip', zipOf([{ name: 'a.txt', data: 'hello', badCrc: true }]))),
  );
  const out = opened.extract('', into());
  assert.ok(!out.ok);
  assert.match(out.error.message, /failed its checksum/);
  opened.close();
});

test('an entry that lies about its size fails rather than being written short', async () => {
  const opened = await reader(
    open(archiveAt('p.zip', zipOf([{ name: 'a.txt', data: 'hello', declaredSize: 99 }]))),
  );
  const out = opened.extract('', into());
  assert.ok(!out.ok);
  assert.match(out.error.message, /not the size it declared/);
  opened.close();
});

test('a tar header that failed its checksum stops the walk', async () => {
  const err = await failed(
    open(archiveAt('p.tar', tarOf([{ name: 'a.txt', data: 'x', badChecksum: true }])), 'p.tar'),
  );
  assert.match(err.message, /failed its checksum/);
});

test('zip64 sizes and offsets are read, record or no record', async () => {
  for (const zip64Eocd of [false, true]) {
    const file = archiveAt(
      'p.zip',
      zipOf([{ name: 'a.txt', data: 'hello', zip64: true }], { zip64Eocd }),
    );
    const opened = await reader(open(file));
    const dest = into();
    const out = opened.extract('', dest);
    assert.ok(out.ok, out.ok ? '' : out.error.message);
    assert.equal(read(dest, 'a.txt'), 'hello');
    opened.close();
  }
});

test('a long name arrives whole, however the tarball carried it', async () => {
  const long = `plugin/${'a-long-directory-name/'.repeat(6)}file.txt`;
  for (const carrier of [{ pax: true }, { gnuLong: true }]) {
    const file = archiveAt('p.tar', tarOf([{ name: long, data: 'deep', ...carrier }]));
    const opened = await reader(open(file, 'p.tar'));
    assert.deepEqual([...opened.names()], [long], JSON.stringify(carrier));
    opened.close();
  }
});

test('what is never a plugins own file never reaches the destination', async () => {
  const entries = [
    { name: MANIFEST, data: manifest },
    { name: '__MACOSX/._my-plugin', data: 'resource fork' },
    { name: '.git/config', data: '[core]' },
    { name: 'skills/.DS_Store', data: 'finder' },
  ];
  const opened = await reader(open(archiveAt('p.zip', zipOf(entries))));
  assert.deepEqual([...opened.names()], [MANIFEST]);
  const dest = into();
  assert.ok(opened.extract('', dest).ok);
  assert.equal(fs.existsSync(dest.join('.git').toString()), false);
  opened.close();
});

// The fetcher sits over the readers, and is where anything they did not check
// for has to become a Failure: these three are the throws the review found.

const throughFetcher = (file: FilePath, work: DirectoryPath) =>
  openThroughFetcher(
    { at: { kind: 'file', file }, describe: 'bad.zip' },
    portsFor(stubFetch({})),
    work,
  );

test('a zip64 locator pointing past the file is a Failure, not a RangeError', async () => {
  const bytes = zipOf(plugin, { zip64Eocd: true });
  const locator = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  assert.ok(locator > 0, 'the fixture wrote a locator');
  bytes.writeBigUInt64LE(0xffffffffffffffffn, locator + 8);

  const handle = throughFetcher(archiveAt('bad.zip', bytes), workspace());
  const files = await handle.files(null);
  assert.ok(!files.ok, 'expected a failure');
  assert.match(files.error.message, /zip64 directory record is missing/);
  handle.cleanup();
});

test('a workspace that cannot be made is a Failure naming it', async () => {
  const blocked = path.join(tmpDir('cp-blocked-'), 'work');
  fs.writeFileSync(blocked, 'a file where the workspace should be');
  const handle = throughFetcher(archiveAt('p.zip', zipOf(plugin)), new DirectoryPath(blocked));
  const files = await handle.files(null);
  assert.ok(!files.ok, 'expected a failure');
  assert.match(files.error.message, /Could not create a working directory/);
  assert.match(files.error.hint ?? '', /CP_STATE_DIR/);
  handle.cleanup();
});

test('a download that cannot be written is a Failure, not an unhandled error event', async () => {
  const url = 'https://acme.com/p.zip';
  const fetchImpl = stubFetch({ [url]: { bytes: zipOf(plugin) } });
  const to = new FilePath(path.join(tmpDir('cp-dl-'), 'no-such-dir', 'download'));
  const got = await downloadArchive({ url, to }, portsFor(fetchImpl));
  assert.ok(!got.ok, 'expected a failure');
  assert.match(got.error.message, /Could not write the download/);
});

test('a slow redirect chain is not read as a stall: each hop gets its own budget', async () => {
  // The budget is thirty seconds, so the test shrinks it rather than waiting:
  // a `setTimeout` asking for exactly IDLE_MS gets a few hundred milliseconds
  // instead, and the ten-minute total is left alone. Three hops, each well
  // inside one budget and all three well past it - armed once for the chain,
  // as it was, the last of them aborts a download that never stalled.
  const IDLE_MS = 30 * 1000;
  const BUDGET = 400;
  const HOP_MS = 150;
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    real(fn, ms === IDLE_MS ? BUDGET : ms)) as typeof globalThis.setTimeout;
  const after = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      real(resolve, ms);
    });

  try {
    const bytes = zipOf(plugin);
    const hops = ['https://acme.com/a.zip', 'https://acme.com/b.zip', 'https://acme.com/c.zip'];
    const fetchImpl: FetchLike = async (url, init) => {
      await after(HOP_MS);
      // What a real fetch does once the signal has fired under it.
      if (init?.signal?.aborted) throw new Error('This operation was aborted');
      const next = hops[hops.indexOf(url) + 1];
      const body = next === undefined ? bytes : Buffer.alloc(0);
      return {
        ok: next === undefined,
        status: next === undefined ? 200 : 302,
        statusText: next === undefined ? 'OK' : 'Found',
        headers: {
          get: (name: string) => (name.toLowerCase() === 'location' ? (next ?? null) : null),
        },
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(body.toString('utf8')),
        arrayBuffer: () => {
          const buffer = new ArrayBuffer(body.byteLength);
          new Uint8Array(buffer).set(body);
          return Promise.resolve(buffer);
        },
      };
    };

    const to = new FilePath(path.join(tmpDir('cp-slow-'), 'download'));
    const got = await downloadArchive({ url: hops[0] as string, to }, portsFor(fetchImpl));
    assert.ok(got.ok, got.ok ? '' : got.error.message);
    assert.equal(got.value, bytes.length);
  } finally {
    globalThis.setTimeout = real;
  }
});

test('a host that answers 5xx is reported as unavailable, without blaming GitHub', async () => {
  const url = 'https://acme.com/p.zip';
  const fetchImpl = stubFetch({ [url]: { status: 503, body: 'nope' } });
  const to = new FilePath(path.join(tmpDir('cp-dl-'), 'download'));
  const got = await downloadArchive({ url, to }, portsFor(fetchImpl));
  assert.ok(!got.ok, 'expected a failure');
  assert.equal(got.error.message, 'acme.com is temporarily unavailable (HTTP 503).');
  assert.ok(!(got.error.hint ?? '').includes('GitHub'), got.error.hint);
});

test('an archive that is not one says what it looks like instead', async () => {
  const err = await failed(open(archiveAt('p.zip', Buffer.from('<!DOCTYPE html><html>'))));
  assert.match(err.message, /is not a zip or a tarball/);
  assert.match(err.hint ?? '', /web page/);
});

test('a zip with no end record is reported as unreadable, not as empty', async () => {
  const err = await failed(open(archiveAt('p.zip', Buffer.from('PK and then nothing'))));
  assert.match(err.message, /could not be read/);
});

test('an entry the unix world named executable keeps that bit where it means something', async (t) => {
  if (process.platform === 'win32') return t.skip('modes are not a thing on Windows');
  const entries = [
    { name: 'hooks/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
    { name: 'README.md', data: 'read me', mode: 0o644 },
  ];
  const opened = await reader(open(archiveAt('p.zip', zipOf(entries))));
  const dest = into();
  assert.ok(opened.extract('', dest).ok);
  assert.ok(fs.statSync(dest.file('hooks', 'run.sh').toString()).mode & 0o111);
  assert.ok(!(fs.statSync(dest.file('README.md').toString()).mode & 0o111));
  opened.close();
});
