import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { findRaw, openManifest, upsert } from '../../src/infrastructure/manifest-store.js';
import type { ManifestContext } from '../../src/types/manifest-context.js';
import { tmpDir, cleanupAll } from '../helpers.js';

test.after(cleanupAll);

// What a row means, as opposed to what the file holds: which rows this build can
// act on, what it drops and says it dropped, and the two writes it makes. The
// bytes are test/infrastructure/manifest-store.test.ts.

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

/** A context over a file seeded with the given rows, and the file itself. */
function seeded(...plugins: unknown[]): { records: ManifestContext; f: string } {
  const f = file();
  if (plugins.length) fs.writeFileSync(f, JSON.stringify({ plugins }));
  return { records: openManifest(f, () => 'AT'), f };
}

test('a missing manifest reads as empty', () => {
  assert.deepEqual(seeded().records.list(), []);
});

test('find matches on repo+plugin, and on plugin alone when no repo is given', () => {
  const { records } = seeded(entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  assert.equal(
    records.find({ plugin: 'my-sdk', repo: 'acme/plugin-marketplace' })?.marketplace,
    'acme',
  );
  assert.equal(records.find({ plugin: 'my-sdk', repo: 'other/repo' }), null);
  assert.equal(records.find({ plugin: 'my-sdk' })?.marketplace, 'acme');
});

test('a manifest written by the PowerShell installer is readable', () => {
  const { records } = seeded({
    plugin: 'legacy-sdk',
    repo: REPO,
    marketplace: 'apimatic',
    ref: 'main',
    targets: ['claude', 'cursor'],
  });
  const listed = records.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].plugin, 'legacy-sdk');
});

test('an unknown target is filtered out on read, keeping the rest', () => {
  const { records } = seeded(entry({ targets: ['claude', 'zed'] }));
  assert.deepEqual(records.list()[0].targets, ['claude']);
});

test('an entry with no usable target is dropped, never read as "all"', () => {
  const { records } = seeded(
    entry({ targets: ['zed'] }), // every target unknown
    entry({ targets: [] }), // recorded with none
    entry({ targets: 'claude' }), // not even an array
  );
  assert.deepEqual(records.list(), []);
});

test('junk entries do not survive read', () => {
  const { records } = seeded(
    null,
    42,
    'my-sdk',
    { targets: ['claude'] },
    {
      plugin: 7,
      targets: ['claude'],
    },
  );
  assert.deepEqual(records.list(), []);
});

test('non-string metadata fields are shed instead of passed along', () => {
  const { records } = seeded(entry({ ref: 42, marketplace: ['x'] }));
  const read = records.list()[0];
  assert.equal(read.ref, undefined);
  assert.equal(read.marketplace, undefined);
  assert.equal(read.repo, REPO, 'valid fields survive');
});

test('targets are deduped into canonical order on read', () => {
  const { records } = seeded(entry({ targets: ['vscode', 'claude', 'claude'] }));
  assert.deepEqual(records.list()[0].targets, ['claude', 'vscode']);
});

test('read names what it ignored instead of hiding it', () => {
  const { records } = seeded(entry(), entry({ plugin: 'future-sdk', targets: ['zed'] }), null);
  const { plugins, ignored } = records.read();
  assert.equal(plugins.length, 1);
  assert.deepEqual(ignored, [
    { plugin: 'future-sdk', repo: REPO, reason: 'unknown target(s): zed' },
    { plugin: null, reason: 'not a plugin entry' },
  ]);
});

test('a row listed without one of its targets is reported too, not just dropped rows', () => {
  const { records } = seeded(entry({ targets: ['vscode', 'zed', 42] }));
  const { plugins, ignored, elided } = records.read();
  assert.deepEqual(plugins[0].targets, ['vscode'], 'the row is still usable');
  assert.deepEqual(ignored, [], 'and it was not ignored');
  assert.deepEqual(elided, [{ plugin: 'my-sdk', repo: REPO, targets: ['zed', '42'] }]);
});

test('a fully readable row reports nothing', () => {
  const { records } = seeded(entry());
  const { ignored, elided } = records.read();
  assert.deepEqual([ignored, elided], [[], []]);
});

test('findRaw returns the rows read hides', () => {
  const { records } = seeded(entry({ plugin: 'future-sdk', targets: ['zed'] }));
  const key = { plugin: 'future-sdk', repo: REPO };
  assert.equal(records.find(key), null, 'the sanitized view hides it');
  assert.deepEqual(records.findRaw(key)?.targets, ['zed']);
});

/**
 * GitHub treats an owner and a name case-insensitively and so does the Claude
 * harness, but the manifest key, this check and `list`'s scope all compared with
 * `===`. Two halves of one run therefore disagreed about whether `--repo
 * Context-Plugins/Plugin-Marketplace` was the marketplace a row already named -
 * this reported a clash for the plugin's own marketplace, and `--force` past it
 * wrote a second row for the same plugin from the same repository.
 */
test('a differently cased spelling of the recorded repo is the same marketplace', () => {
  const { records } = seeded(entry());
  assert.equal(records.conflictFor({ plugin: 'my-sdk', repo: REPO.toUpperCase() }), null);
  assert.ok(records.find({ plugin: 'my-sdk', repo: REPO.toUpperCase() }), 'and the same row');
});

// Cursor and VS Code keep plugins in a flat <plugin>/ directory, so the same id
// from a second marketplace would overwrite the first.
test('a conflict is reported only for the same id from another marketplace', () => {
  const { records } = seeded(entry());
  assert.equal(records.conflictFor({ plugin: 'my-sdk', repo: REPO }), null, 'the same marketplace');
  assert.equal(records.conflictFor({ plugin: 'other', repo: 'acme/m' }), null, 'another plugin');
  const clash = records.conflictFor({ plugin: 'my-sdk', repo: 'acme/m' });
  assert.match(clash?.message ?? '', /already installed from a different marketplace/);
  assert.match(clash?.hint ?? '', /--force/);
});

/**
 * The rule this class exists to hold: a row is rebuilt from the raw row, never
 * from the read view, so a field and a target name belonging to a newer CLI
 * survive a rewrite. Reading and rebuilding are one operation here, which is
 * what removes the way a caller used to be able to pair them wrongly.
 */
test('recording an install keeps the fields and targets this build cannot read', () => {
  const { records, f } = seeded(
    entry({ targets: ['cursor', 'zed'], keptByANewerCli: { any: 'shape' } }),
  );
  records.recordInstall({
    plugin: 'my-sdk',
    repo: REPO,
    marketplace: 'apimatic',
    ref: 'v2',
    installed: ['vscode'],
    untouched: ['cursor'],
  });
  const raw = findRaw(f, { plugin: 'my-sdk', repo: REPO });
  assert.deepEqual(raw?.targets, ['cursor', 'vscode', 'zed'], 'canonical order, then the foreign');
  assert.deepEqual(raw?.keptByANewerCli, { any: 'shape' });
  assert.equal(raw?.ref, 'v2', 'and what this run knows is updated');
  assert.equal(raw?.installedAt, 'AT');
});

test('recording an install writes a row where there was none', () => {
  const { records, f } = seeded();
  records.recordInstall({
    plugin: 'my-sdk',
    repo: REPO,
    marketplace: 'apimatic',
    ref: 'main',
    installed: ['claude'],
    untouched: [],
  });
  assert.deepEqual(findRaw(f, { plugin: 'my-sdk', repo: REPO })?.targets, ['claude']);
});

test('applying an uninstall shortens, removes, or leaves the row alone', () => {
  const key = { plugin: 'my-sdk', repo: REPO };
  const decision = {
    removed: [],
    failed: [],
    cleared: [],
    forced: [],
    stuck: [],
    droppedUnknown: [],
    rowLeft: 'none' as const,
    write: 'none' as const,
    targets: [] as unknown[],
  };

  const untouched = seeded(entry({ targets: ['cursor', 'zed'] }));
  untouched.records.applyUninstall(key, decision);
  assert.deepEqual(findRaw(untouched.f, key)?.targets, ['cursor', 'zed'], 'none writes nothing');

  const shortened = seeded(entry({ targets: ['cursor', 'zed'], keptByANewerCli: 1 }));
  shortened.records.applyUninstall(key, { ...decision, write: 'shorten', targets: ['zed'] });
  const row = findRaw(shortened.f, key);
  assert.deepEqual(row?.targets, ['zed'], 'the foreign name stays on the row');
  assert.equal(row?.keptByANewerCli, 1, 'and so does the foreign field');

  const dropped = seeded(entry({ targets: ['cursor'] }), entry({ plugin: 'other' }));
  dropped.records.applyUninstall(key, { ...decision, write: 'remove' });
  assert.equal(findRaw(dropped.f, key), null);
  assert.ok(findRaw(dropped.f, { plugin: 'other', repo: REPO }), 'and only that row');
});

test('a shorten with no row on disk writes nothing rather than inventing one', () => {
  const { records, f } = seeded();
  upsert(f, entry({ plugin: 'other' }));
  records.applyUninstall(
    { plugin: 'my-sdk', repo: REPO },
    {
      removed: [],
      failed: [],
      cleared: [],
      forced: [],
      stuck: [],
      droppedUnknown: [],
      rowLeft: 'none',
      write: 'shorten',
      targets: ['cursor'],
    },
  );
  assert.equal(findRaw(f, { plugin: 'my-sdk', repo: REPO }), null);
  assert.equal(records.list().length, 1);
});
