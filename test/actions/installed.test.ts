import test from 'node:test';
import assert from 'node:assert';

import { InstalledAction } from '../../src/actions/installed.js';
import { matchesKey, type EntryKey, type RawManifest } from '../../src/types/installed-record.js';
import { ManifestContext } from '../../src/types/manifest-context.js';
import type { ManifestStore } from '../../src/types/ports.js';

// The action over its port, so nothing here touches a file. What the report is
// rendered as belongs to test/commands/installed.test.ts.

const REPO = 'acme/plugin-marketplace';

const row = (plugin: string, targets: unknown, over: Record<string, unknown> = {}) => ({
  plugin,
  repo: REPO,
  ref: 'main',
  marketplace: 'acme',
  targets,
  installedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** The store as an array, matching keys the way the real one does. */
function fakeStore(rows: Record<string, unknown>[]): ManifestStore {
  return {
    readRaw: (): RawManifest => ({ version: 1, plugins: [...rows] }),
    findAllRaw: (key: EntryKey) => rows.filter((r) => matchesKey(r, key)),
    upsert: () => {
      throw new Error('installed never writes');
    },
    remove: () => {
      throw new Error('installed never writes');
    },
  };
}

const actionOver = (rows: Record<string, unknown>[]) =>
  new InstalledAction(new ManifestContext(fakeStore(rows), () => 'now'));

const ROWS = [
  row('alpha', ['cursor']),
  row('beta', ['cursor', 'vscode']),
  row('gamma', ['claude']),
];

const listed = (report: { entries: { plugin: string }[] }): string[] =>
  report.entries.map((e) => e.plugin);

test('with no filter every recorded plugin is listed, and nothing is scoped', () => {
  const result = actionOver(ROWS).execute({});

  assert.equal(result.isSuccess(), true);
  assert.deepEqual(listed(result.report), ['alpha', 'beta', 'gamma']);
  assert.equal(result.report.scoped, false, 'every editor is not a scope worth naming');
  assert.equal(result.exitCode(), 0);
});

test('a filter selects the plugins recorded for those editors', () => {
  const result = actionOver(ROWS).execute({ targets: ['vscode'] });

  assert.deepEqual(listed(result.report), ['beta']);
  assert.deepEqual(result.report.want, ['vscode']);
  assert.equal(result.report.scoped, true);
});

/**
 * `--targets` chooses which plugins are listed, not what is said about them.
 * Trimming the row to the editors asked for would read as though the plugin
 * were installed nowhere else, and the next `uninstall` would surprise.
 */
test('a listed plugin still names every editor it is recorded for', () => {
  const result = actionOver(ROWS).execute({ targets: ['vscode'] });

  assert.deepEqual(result.report.entries[0]?.targets, ['cursor', 'vscode']);
});

test('all is not a scope, and reads exactly as no filter', () => {
  const every = actionOver(ROWS).execute({ targets: ['all'] });
  const none = actionOver(ROWS).execute({});

  assert.deepEqual(listed(every.report), listed(none.report));
  assert.equal(every.report.scoped, false);
});

test('a filter that matches nothing succeeds with nothing in it', () => {
  const result = actionOver([row('alpha', ['cursor'])]).execute({ targets: ['claude'] });

  assert.equal(result.isSuccess(), true, 'an empty answer is an answer');
  assert.deepEqual(listed(result.report), []);
  assert.equal(result.report.scoped, true, 'so the caller can say which editor it means');
});

test('an unknown editor fails, naming it, and lists nothing', () => {
  const result = actionOver(ROWS).execute({ targets: ['emacs'] });

  assert.equal(result.isFailed(), true);
  assert.equal(result.exitCode(), 1);
  assert.match(result.failure?.message ?? '', /Unknown target\(s\): emacs/);
  assert.deepEqual(listed(result.report), []);
});

/**
 * The report carries what the read view could not show even when the flag is
 * refused, because those rows are in a file the user can see and the failure is
 * about the command line, not about the file.
 */
test('the gaps in the read view travel with the report, failure or not', () => {
  const rows = [
    row('alpha', ['cursor']),
    row('future', ['cursor', 'zed']),
    row('junk', 'not-an-array'),
  ];

  const ok = actionOver(rows).execute({});
  assert.deepEqual(
    ok.report.gaps.elided.map((e) => e.plugin),
    ['future'],
    'a row listed without a target this build knows',
  );
  assert.deepEqual(
    ok.report.gaps.ignored.map((e) => e.plugin),
    ['junk'],
    'a row it could not read at all',
  );

  const refused = actionOver(rows).execute({ targets: ['emacs'] });
  assert.deepEqual(
    refused.report.gaps.ignored.map((e) => e.plugin),
    ['junk'],
  );
});

// An empty `targets` array reads as "every harness", which is why a row with no
// known target must be dropped by the read view rather than kept as `[]`.
test('a row with no usable target is not listed at all', () => {
  const result = actionOver([row('alpha', ['cursor']), row('empty', [])]).execute({});

  assert.deepEqual(listed(result.report), ['alpha']);
  assert.deepEqual(
    result.report.gaps.ignored.map((e) => e.plugin),
    ['empty'],
  );
});
