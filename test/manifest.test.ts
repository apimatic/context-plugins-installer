import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as manifest from '../src/manifest.js';
import { isPlainObject } from '../src/util.js';
import { tmpDir, cleanupAll } from './helpers.js';

test.after(cleanupAll);

const REPO = 'context-plugins/plugin-marketplace';

const file = (): string => path.join(tmpDir('cp-manifest-'), 'installed.json');

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  plugin: 'my-sdk',
  repo: REPO,
  marketplace: 'apimatic',
  ref: 'main',
  targets: ['claude'],
  ...over,
});

test('a missing manifest reads as empty', () => {
  assert.deepEqual(manifest.read(file()).plugins, []);
});

test('a corrupt manifest reads as empty instead of throwing', () => {
  const f = file();
  fs.writeFileSync(f, 'not json at all');
  assert.deepEqual(manifest.read(f).plugins, []);
});

test('upsert adds an entry and stamps the version', () => {
  const f = file();
  manifest.upsert(f, entry());
  const data = manifest.read(f);
  assert.equal(data.version, manifest.MANIFEST_VERSION);
  assert.equal(data.plugins.length, 1);
  assert.equal(data.plugins[0].plugin, 'my-sdk');
});

test('upsert replaces the same repo+plugin rather than duplicating', () => {
  const f = file();
  manifest.upsert(f, entry({ targets: ['claude'] }));
  manifest.upsert(f, entry({ targets: ['claude', 'cursor', 'vscode'] }));
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0].targets, ['claude', 'cursor', 'vscode']);
});

test('the same plugin id from two marketplaces coexists', () => {
  const f = file();
  manifest.upsert(
    f,
    entry({ repo: 'context-plugins/plugin-marketplace', marketplace: 'apimatic' }),
  );
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 2, 'keyed by repo+plugin, not plugin alone');
  assert.deepEqual(plugins.map((p) => p.repo).sort(), [
    'acme/plugin-marketplace',
    'context-plugins/plugin-marketplace',
  ]);
});

test('find matches on repo+plugin, and on plugin alone when no repo is given', () => {
  const f = file();
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  assert.equal(
    manifest.find(f, { plugin: 'my-sdk', repo: 'acme/plugin-marketplace' })?.marketplace,
    'acme',
  );
  assert.equal(manifest.find(f, { plugin: 'my-sdk', repo: 'other/repo' }), null);
  assert.equal(manifest.find(f, { plugin: 'my-sdk' })?.marketplace, 'acme');
});

test('remove deletes only the matching repo+plugin', () => {
  const f = file();
  manifest.upsert(f, entry({ repo: 'context-plugins/plugin-marketplace' }));
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace' }));
  const removed = manifest.remove(f, { plugin: 'my-sdk', repo: 'acme/plugin-marketplace' });
  assert.equal(removed, 1);
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].repo, 'context-plugins/plugin-marketplace');
});

test('a manifest written by the PowerShell installer is readable', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      plugins: [
        {
          plugin: 'legacy-sdk',
          repo: 'context-plugins/plugin-marketplace',
          marketplace: 'apimatic',
          ref: 'main',
          targets: ['claude', 'cursor'],
        },
      ],
    }),
  );
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].plugin, 'legacy-sdk');
});

test('an unknown target is filtered out on read, keeping the rest', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ plugins: [entry({ targets: ['claude', 'zed'] })] }));
  assert.deepEqual(manifest.list(f)[0].targets, ['claude']);
});

test('an entry with no usable target is dropped, never read as "all"', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      plugins: [
        entry({ targets: ['zed'] }), // every target unknown
        entry({ targets: [] }), // recorded with none
        entry({ targets: 'claude' }), // not even an array
      ],
    }),
  );
  assert.deepEqual(manifest.list(f), []);
});

test('junk entries do not survive read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      plugins: [null, 42, 'my-sdk', { targets: ['claude'] }, { plugin: 7, targets: ['claude'] }],
    }),
  );
  assert.deepEqual(manifest.list(f), []);
});

test('non-string metadata fields are shed instead of passed along', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ plugins: [entry({ ref: 42, marketplace: ['x'] })] }));
  const read = manifest.list(f)[0];
  assert.equal(read.ref, undefined);
  assert.equal(read.marketplace, undefined);
  assert.equal(read.repo, 'context-plugins/plugin-marketplace', 'valid fields survive');
});

test('targets are deduped into canonical order on read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ targets: ['vscode', 'claude', 'claude'] })] }),
  );
  assert.deepEqual(manifest.list(f)[0].targets, ['claude', 'vscode']);
});

test('read names what it ignored instead of hiding it', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry(), entry({ plugin: 'future-sdk', targets: ['zed'] }), null] }),
  );
  const { plugins, ignored } = manifest.read(f);
  assert.equal(plugins.length, 1);
  assert.deepEqual(ignored, [
    { plugin: 'future-sdk', repo: REPO, reason: 'unknown target(s): zed' },
    { plugin: null, reason: 'not a plugin entry' },
  ]);
});

test('a row listed without one of its targets is reported too, not just dropped rows', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ plugins: [entry({ targets: ['vscode', 'zed', 42] })] }));
  const { plugins, ignored, elided } = manifest.read(f);
  assert.deepEqual(plugins[0].targets, ['vscode'], 'the row is still usable');
  assert.deepEqual(ignored, [], 'and it was not ignored');
  assert.deepEqual(elided, [{ plugin: 'my-sdk', repo: REPO, targets: ['zed', '42'] }]);
});

test('a fully readable row reports nothing', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ plugins: [entry()] }));
  const { ignored, elided } = manifest.read(f);
  assert.deepEqual([ignored, elided], [[], []]);
});

test('an unrelated upsert never deletes entries this build cannot read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ plugin: 'future-sdk', targets: ['zed'] }), null] }),
  );
  manifest.upsert(f, entry());
  const onDisk: unknown[] = JSON.parse(fs.readFileSync(f, 'utf8')).plugins;
  assert.equal(onDisk.length, 3, 'the unreadable entries are still on disk');
  assert.ok(
    onDisk.some(
      (p) =>
        isPlainObject(p) &&
        p.plugin === 'future-sdk' &&
        Array.isArray(p.targets) &&
        p.targets.includes('zed'),
    ),
  );
  assert.ok(onDisk.includes(null));
});

test('remove leaves entries it cannot read alone', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry(), entry({ plugin: 'future-sdk', targets: ['zed'] })] }),
  );
  manifest.remove(f, { plugin: 'my-sdk', repo: 'context-plugins/plugin-marketplace' });
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8')).plugins;
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].plugin, 'future-sdk');
});

test('findRaw returns the rows read hides', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ plugin: 'future-sdk', targets: ['zed'] })] }),
  );
  const key = { plugin: 'future-sdk', repo: 'context-plugins/plugin-marketplace' };
  assert.equal(manifest.find(f, key), null, 'the sanitized view hides it');
  assert.deepEqual(manifest.findRaw(f, key)?.targets, ['zed']);
});

/**
 * A version this build does not know belongs to a newer CLI. `readRaw` keeps it
 * on purpose, and `write` used to stamp its own over the top - erasing the only
 * migration signal the format has, on an install that touched one row.
 */
test('a version written by a newer CLI survives an upsert', () => {
  const file = path.join(tmpDir('cp-manifest-'), 'installed.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 2, plugins: [{ plugin: 'from-v2', targets: ['cursor'] }] }),
  );

  manifest.upsert(file, { plugin: 'new-row', repo: 'o/r', targets: ['cursor'] });

  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; plugins: unknown[] };
  assert.equal(raw.version, 2, 'the foreign version is preserved');
  assert.equal(raw.plugins.length, 2, 'and the row it owned is still there');
});

test('a manifest with no version is stamped with this build', () => {
  const file = path.join(tmpDir('cp-manifest-'), 'installed.json');
  manifest.upsert(file, { plugin: 'a', repo: 'o/r', targets: ['cursor'] });
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number }).version, 1);
});

// Written through a rename, so a crash mid-write leaves the previous file
// rather than a truncated one that reads back as empty and loses every row.
test('writing leaves no temporary file behind', () => {
  const dir = tmpDir('cp-manifest-');
  const file = path.join(dir, 'installed.json');
  manifest.upsert(file, { plugin: 'a', repo: 'o/r', targets: ['cursor'] });
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')),
    [],
  );
});
