import test from 'node:test';
import assert from 'node:assert';

import { decideUninstall, uninstallLines } from '../../src/application/uninstall-decision.js';
import type { HarnessName, UninstallOutcome } from '../../src/types/harness.js';
import {
  MANIFEST_VERSION,
  matchesKey,
  type EntryKey,
  type RawManifest,
} from '../../src/types/installed-record.js';
import { ManifestContext } from '../../src/types/manifest-context.js';
import type { ManifestStore } from '../../src/types/ports.js';

// What a row means, as opposed to what the file holds: which rows this build can
// act on, what it drops and says it dropped, and the two writes it makes.
//
// Driven over the port with the rows in an array, which is the point of the
// port: this class lives in `types/`, so it has to work without knowing there is
// a file, and nothing else demonstrated that it does. The bytes are
// test/infrastructure/manifest-store.test.ts; the two halves wired together are
// test/install.test.ts, which asserts on real files after real installs.

const REPO = 'context-plugins/plugin-marketplace';

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  plugin: 'my-sdk',
  repo: REPO,
  marketplace: 'apimatic',
  ref: 'main',
  targets: ['claude'],
  ...over,
});

interface Fake extends ManifestStore {
  /** The rows as they stand, which is what the file would hold. */
  rows: unknown[];
}

/**
 * The port over an array. Matching goes through the same `matchesKey` the real
 * store uses, so the one rule a fake could quietly get wrong is not restated.
 */
function fakeStore(...plugins: unknown[]): Fake {
  let rows: unknown[] = [...plugins];
  const raw = (): RawManifest => ({ version: MANIFEST_VERSION, plugins: rows });
  return {
    get rows() {
      return rows;
    },
    readRaw: raw,
    findAllRaw: (key: EntryKey) =>
      rows.filter((p): p is Record<string, unknown> => matchesKey(p, key)),
    upsert: (row) => {
      rows = rows.filter((p) => !matchesKey(p, row));
      rows.push(row);
      return raw();
    },
    remove: (key) => {
      const before = rows.length;
      rows = rows.filter((p) => !matchesKey(p, key));
      return before - rows.length;
    },
  };
}

/** A context over those rows, with a clock a test can assert against. */
function seeded(...plugins: unknown[]): { records: ManifestContext; store: Fake } {
  const store = fakeStore(...plugins);
  return { records: new ManifestContext(store, () => 'AT'), store };
}

const KEY: EntryKey = { plugin: 'my-sdk', repo: REPO };

const rowIn = (store: Fake, key: EntryKey = KEY): Record<string, unknown> | undefined =>
  store.rows.filter((p): p is Record<string, unknown> => matchesKey(p, key))[0];

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
  assert.match(clash?.message ?? '', /already installed from a different source/);
  assert.match(clash?.hint ?? '', /--force/);
});

/**
 * The rule this class exists to hold: a row is rebuilt from the raw row, never
 * from the read view, so a field and a target name belonging to a newer CLI
 * survive a rewrite. Reading and rebuilding are one operation here, which is
 * what removes the way a caller used to be able to pair them wrongly.
 */
test('recording an install keeps the fields and targets this build cannot read', () => {
  const { records, store } = seeded(
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
  const raw = rowIn(store);
  assert.deepEqual(raw?.targets, ['cursor', 'vscode', 'zed'], 'canonical order, then the foreign');
  assert.deepEqual(raw?.keptByANewerCli, { any: 'shape' });
  assert.equal(raw?.ref, 'v2', 'and what this run knows is updated');
  assert.equal(raw?.installedAt, 'AT');
});

test('recording an install writes a row where there was none', () => {
  const { records, store } = seeded();
  records.recordInstall({
    plugin: 'my-sdk',
    repo: REPO,
    marketplace: 'apimatic',
    ref: 'main',
    installed: ['claude'],
    untouched: [],
  });
  assert.deepEqual(rowIn(store)?.targets, ['claude']);
});

/**
 * Comparing the repo the way GitHub does made "one key, one row" false. A
 * manifest an older build wrote can hold both spellings as separate rows - it
 * took the very bug that fix repairs, plus `--force`, to write one - and
 * `upsert` and `remove` now act on both. Reading only the first meant the
 * decision never saw the second row, so `remove` took its targets and fields
 * out with nothing naming them: the one thing the uninstall summary may never
 * do.
 */
test('the rows an older build wrote in two spellings read as one row', () => {
  const { records } = seeded(
    entry({ repo: 'Acme/M', targets: ['cursor'], mine: 1 }),
    entry({ repo: 'acme/m', targets: ['vscode', 'zed'], yours: 2 }),
  );
  const key = { plugin: 'my-sdk', repo: 'acme/m' };
  assert.deepEqual(records.find(key)?.targets, ['cursor', 'vscode'], 'the known names, unioned');
  const raw = records.findRaw(key);
  assert.deepEqual(raw?.targets, ['cursor', 'vscode', 'zed'], 'and the foreign one after them');
  assert.deepEqual([raw?.mine, raw?.yours], [1, 2], 'with the fields of both rows');
});

test('a key with no repo spans marketplaces, so those rows are not folded', () => {
  const { records } = seeded(
    entry({ repo: 'acme/m', targets: ['cursor'] }),
    entry({ repo: 'other/m', targets: ['vscode'] }),
  );
  assert.deepEqual(
    records.find({ plugin: 'my-sdk' })?.targets,
    ['cursor'],
    'two marketplaces are two plugins that share an id',
  );
});

test('an uninstall decides from every row the key matches, and writes them as one', () => {
  const { records, store } = seeded(
    entry({ repo: 'Acme/M', targets: ['cursor'] }),
    entry({ repo: 'acme/m', targets: ['cursor', 'zed'], yours: 2 }),
  );
  const key = { plugin: 'my-sdk', repo: 'acme/m' };
  const decision = decideUninstall({
    recorded: records.findRaw(key),
    outcomes: new Map<HarnessName, UninstallOutcome>([['cursor', 'removed']]),
    want: ['cursor'],
    force: false,
  });
  assert.equal(decision.write, 'shorten', 'the foreign name is still on the row');
  records.applyUninstall(key, decision);
  const raw = rowIn(store, key);
  assert.deepEqual(raw?.targets, ['zed'], 'so the row stays, shortened');
  assert.equal(raw?.yours, 2, 'with the field the second row held');
  assert.equal(store.rows.length, 1, 'and both spellings are now one row');
  assert.match(
    uninstallLines(decision, { plugin: 'my-sdk', bin: 'cp' })
      .map((l) => l.text)
      .join(' | '),
    /--force/,
    'a row this build cannot act on is never left in silence',
  );
});

test('recording an install keeps what a second spelling of the row held', () => {
  const { records, store } = seeded(
    entry({ repo: 'Acme/M', targets: ['cursor'] }),
    entry({ repo: 'acme/m', targets: ['vscode'], yours: 2 }),
  );
  records.recordInstall({
    plugin: 'my-sdk',
    repo: 'acme/m',
    marketplace: 'apimatic',
    ref: 'main',
    installed: ['claude'],
    untouched: records.find({ plugin: 'my-sdk', repo: 'acme/m' })?.targets ?? [],
  });
  const raw = rowIn(store, { plugin: 'my-sdk', repo: 'acme/m' });
  assert.deepEqual(raw?.targets, ['claude', 'cursor', 'vscode']);
  assert.equal(raw?.yours, 2);
  assert.equal(store.rows.length, 1);
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
  assert.deepEqual(rowIn(untouched.store, key)?.targets, ['cursor', 'zed'], 'none writes nothing');

  const shortened = seeded(entry({ targets: ['cursor', 'zed'], keptByANewerCli: 1 }));
  shortened.records.applyUninstall(key, { ...decision, write: 'shorten', targets: ['zed'] });
  const row = rowIn(shortened.store, key);
  assert.deepEqual(row?.targets, ['zed'], 'the foreign name stays on the row');
  assert.equal(row?.keptByANewerCli, 1, 'and so does the foreign field');

  const dropped = seeded(entry({ targets: ['cursor'] }), entry({ plugin: 'other' }));
  dropped.records.applyUninstall(key, { ...decision, write: 'remove' });
  assert.equal(rowIn(dropped.store, key), undefined);
  assert.ok(rowIn(dropped.store, { plugin: 'other', repo: REPO }), 'and only that row');
});

test('a shorten with no row of its own writes nothing rather than inventing one', () => {
  const { records, store } = seeded(entry({ plugin: 'other' }));
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
  assert.equal(rowIn(store), undefined);
  assert.equal(store.rows.length, 1);
});

// The claim the port makes, as a test: the class is in types/, so the only thing
// it may reach for is the store it was handed. Every case above ran without a
// file; this one names the calls it makes and says so.
test('the context reaches its store and nothing else', () => {
  const asked: string[] = [];
  const store: ManifestStore = {
    readRaw: () => {
      asked.push('readRaw');
      return { version: 1, plugins: [entry()] };
    },
    findAllRaw: () => {
      asked.push('findAllRaw');
      return [entry()];
    },
    upsert: (row) => {
      asked.push('upsert');
      return { version: 1, plugins: [row] };
    },
    remove: () => {
      asked.push('remove');
      return 1;
    },
  };
  const records = new ManifestContext(store, () => 'AT');
  records.read();
  records.find(KEY);
  records.findRaw(KEY);
  records.conflictFor({ plugin: 'my-sdk', repo: 'acme/m' });
  records.recordInstall({
    plugin: 'my-sdk',
    repo: REPO,
    marketplace: 'apimatic',
    ref: 'main',
    installed: ['claude'],
    untouched: [],
  });
  records.applyUninstall(KEY, {
    removed: [],
    failed: [],
    cleared: [],
    forced: [],
    stuck: [],
    droppedUnknown: [],
    rowLeft: 'none',
    write: 'remove',
    targets: [],
  });
  assert.deepEqual(asked, [
    'readRaw',
    'findAllRaw',
    'findAllRaw',
    'readRaw',
    'findAllRaw',
    'upsert',
    'remove',
  ]);
});
