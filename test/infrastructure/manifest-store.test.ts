import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { findRaw, readRaw, remove, upsert } from '../../src/infrastructure/manifest-store.js';
import { MANIFEST_VERSION } from '../../src/types/installed-record.js';
import { isPlainObject } from '../../src/util.js';
import { tmpDir, cleanupAll } from '../helpers.js';

test.after(cleanupAll);

// installed.json as bytes. Every assertion here is about the file: what it
// holds, what survives a write, and what a write must never touch. What a row
// means is test/types/manifest-context.test.ts.

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

const rows = (f: string): unknown[] => readRaw(f).plugins;

test('a missing manifest reads as empty', () => {
  assert.deepEqual(rows(file()), []);
});

test('a corrupt manifest reads as empty instead of throwing', () => {
  const f = file();
  fs.writeFileSync(f, 'not json at all');
  assert.deepEqual(rows(f), []);
});

test('upsert adds an entry and stamps the version', () => {
  const f = file();
  upsert(f, entry());
  const data = readRaw(f);
  assert.equal(data.version, MANIFEST_VERSION);
  assert.equal(data.plugins.length, 1);
  assert.equal(findRaw(f, { plugin: 'my-sdk', repo: REPO })?.plugin, 'my-sdk');
});

test('upsert replaces the same repo+plugin rather than duplicating', () => {
  const f = file();
  upsert(f, entry({ targets: ['claude'] }));
  upsert(f, entry({ targets: ['claude', 'cursor', 'vscode'] }));
  assert.equal(rows(f).length, 1);
  assert.deepEqual(findRaw(f, { plugin: 'my-sdk', repo: REPO })?.targets, [
    'claude',
    'cursor',
    'vscode',
  ]);
});

// The key folds case, because the repo it holds is a GitHub slug. Without it a
// run that spelled `--repo` differently wrote a second row for a plugin that was
// already installed, and neither row could then be uninstalled by the other's
// spelling.
test('a row is keyed by the repo case-insensitively', () => {
  const f = file();
  upsert(f, entry({ repo: 'Context-Plugins/Plugin-Marketplace' }));
  upsert(f, entry({ repo: REPO, targets: ['cursor'] }));
  assert.equal(rows(f).length, 1, 'the same repository, so the same row');
  assert.deepEqual(
    findRaw(f, { plugin: 'my-sdk', repo: 'CONTEXT-PLUGINS/PLUGIN-MARKETPLACE' })?.targets,
    ['cursor'],
  );
  assert.equal(remove(f, { plugin: 'my-sdk', repo: REPO.toUpperCase() }), 1);
});

test('the same plugin id from two marketplaces coexists', () => {
  const f = file();
  upsert(f, entry({ repo: REPO, marketplace: 'apimatic' }));
  upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  const listed = rows(f).filter(isPlainObject);
  assert.equal(listed.length, 2, 'keyed by repo+plugin, not plugin alone');
  assert.deepEqual(listed.map((p) => p.repo).sort(), ['acme/plugin-marketplace', REPO]);
});

test('remove deletes only the matching repo+plugin', () => {
  const f = file();
  upsert(f, entry({ repo: REPO }));
  upsert(f, entry({ repo: 'acme/plugin-marketplace' }));
  assert.equal(remove(f, { plugin: 'my-sdk', repo: 'acme/plugin-marketplace' }), 1);
  const listed = rows(f).filter(isPlainObject);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].repo, REPO);
});

test('an unrelated upsert never deletes entries this build cannot read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ plugin: 'future-sdk', targets: ['zed'] }), null] }),
  );
  upsert(f, entry());
  const onDisk = rows(f);
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
  remove(f, { plugin: 'my-sdk', repo: REPO });
  const onDisk = rows(f).filter(isPlainObject);
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].plugin, 'future-sdk');
});

test('findRaw returns a row whatever shape its fields are in', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ plugin: 'future-sdk', targets: ['zed'] })] }),
  );
  assert.deepEqual(findRaw(f, { plugin: 'future-sdk', repo: REPO })?.targets, ['zed']);
  assert.equal(findRaw(f, { plugin: 'future-sdk', repo: 'other/repo' }), null);
});

/**
 * A version this build does not know belongs to a newer CLI. `readRaw` keeps it
 * on purpose, and `write` used to stamp its own over the top - erasing the only
 * migration signal the format has, on an install that touched one row.
 */
test('a version written by a newer CLI survives an upsert', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ version: 2, plugins: [{ plugin: 'from-v2', targets: ['cursor'] }] }),
  );

  upsert(f, { plugin: 'new-row', repo: 'o/r', targets: ['cursor'] });

  const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { version: number; plugins: unknown[] };
  assert.equal(raw.version, 2, 'the foreign version is preserved');
  assert.equal(raw.plugins.length, 2, 'and the row it owned is still there');
});

test('a manifest with no version is stamped with this build', () => {
  const f = file();
  upsert(f, { plugin: 'a', repo: 'o/r', targets: ['cursor'] });
  assert.equal((JSON.parse(fs.readFileSync(f, 'utf8')) as { version: number }).version, 1);
});

// Written through a rename, so a crash mid-write leaves the previous file
// rather than a truncated one that reads back as empty and loses every row.
test('writing leaves no temporary file behind', () => {
  const dir = tmpDir('cp-manifest-');
  upsert(path.join(dir, 'installed.json'), { plugin: 'a', repo: 'o/r', targets: ['cursor'] });
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp')),
    [],
  );
});
