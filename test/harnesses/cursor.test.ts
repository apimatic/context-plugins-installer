import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CursorHarness } from '../../src/harnesses/cursor.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import { RepoMarketplace } from '../../src/types/marketplace-origin.js';
import type { HarnessContext, HarnessEvent, HarnessOpts } from '../../src/types/harness.js';
import { cleanupAll, outcome, plainly, tmpDir } from '../helpers.js';

test.after(cleanupAll);

const cursor = new CursorHarness();
const PLUGIN = 'my-sdk';

/**
 * A machine with Cursor either installed or not. Cursor's copy lives inside
 * Cursor's own root, which is why a missing root is the difference between
 * "there is nothing there" and "this cannot be looked at".
 */
function machine({ installed = true, hasPluginJson = true, copied = false } = {}) {
  const root = tmpDir('cp-cursor-');
  const env = { CP_CURSOR_DIR: path.join(root, '.cursor') };
  if (installed) fs.mkdirSync(env.CP_CURSOR_DIR, { recursive: true });

  const src = path.join(root, 'source');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ name: PLUGIN }));
  if (hasPluginJson) {
    fs.mkdirSync(path.join(src, '.cursor-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(src, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: PLUGIN }),
    );
  }

  const dest = path.join(env.CP_CURSOR_DIR, 'plugins', 'local', PLUGIN);
  if (copied) {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'plugin.json'), '{"name":"stale"}');
  }

  const events: HarnessEvent[] = [];
  const ctx: HarnessContext = {
    plugin: PLUGIN,
    origin: new RepoMarketplace('apimatic/context-plugins', 'context-plugins'),
    srcDir: new DirectoryPath(src),
    listener: (e) => events.push(e),
  };
  const opts: HarnessOpts = { env, home: root };
  return { ctx, opts, dest, events, kinds: (): string[] => events.map((e) => e.kind) };
}

test('an install copies the plugin in and says where, then how to reload', async () => {
  const m = machine();

  assert.equal(outcome(await cursor.install(m.ctx, m.opts)), 'installed');

  assert.ok(fs.existsSync(path.join(m.dest, 'plugin.json')), 'the files are in place');
  assert.deepEqual(m.kinds(), ['copied', 'reload']);
  assert.deepEqual(plainly(m.events[0]), {
    harness: 'cursor',
    kind: 'copied',
    dest: m.dest,
  });
});

test('an install replaces an older copy rather than merging into it', async () => {
  const m = machine({ copied: true });

  assert.equal(outcome(await cursor.install(m.ctx, m.opts)), 'installed');

  const written = JSON.parse(fs.readFileSync(path.join(m.dest, 'plugin.json'), 'utf8'));
  assert.equal(written.name, PLUGIN, 'the stale copy is gone, not written over in part');
});

// Cursor may not list a plugin with no manifest of its own, but the files are
// still valid for everything else, so this is a warning and not a refusal.
test('a source with no .cursor-plugin manifest is installed anyway, with a word about it', async () => {
  const m = machine({ hasPluginJson: false });

  assert.equal(outcome(await cursor.install(m.ctx, m.opts)), 'installed');

  assert.deepEqual(m.kinds(), ['no-plugin-json', 'copied', 'reload']);
});

test('with Cursor not installed nothing is copied and the root is named', async () => {
  const m = machine({ installed: false });

  assert.equal(outcome(await cursor.install(m.ctx, m.opts)), 'skipped');

  assert.equal(fs.existsSync(m.dest), false);
  assert.deepEqual(plainly(m.events), [
    { harness: 'cursor', kind: 'not-installed', root: cursor.location(m.opts).toString() },
  ]);
});

test('with no source fetched the install skips rather than emptying the copy', async () => {
  const m = machine({ copied: true });

  assert.equal(outcome(await cursor.install({ ...m.ctx, srcDir: null }, m.opts)), 'skipped');

  assert.ok(fs.existsSync(m.dest), 'the existing copy is left alone');
  assert.deepEqual(m.kinds(), ['no-source']);
});

test('an uninstall removes the copy and says how to reload', async () => {
  const m = machine({ copied: true });

  assert.equal(await cursor.uninstall(m.ctx, m.opts), 'removed');

  assert.equal(fs.existsSync(m.dest), false);
  assert.deepEqual(m.kinds(), ['removed', 'reload']);
});

// `absent` is a positive finding: the harness looked and there was nothing, so
// the record is what drifted and the row is cleared.
test('an uninstall with nothing there is absent, and says where it looked', async () => {
  const m = machine();

  assert.equal(await cursor.uninstall(m.ctx, m.opts), 'absent');

  assert.deepEqual(plainly(m.events), [
    { harness: 'cursor', kind: 'nothing-to-remove', dest: m.dest },
  ]);
});

/**
 * The one case that must not be `absent`: with Cursor's root gone the copy's
 * path cannot be verified, so "there is nothing there" is not established and
 * the record has to stand. Reading this as absence would strand a plugin whose
 * files are still on a machine that has Cursor installed elsewhere.
 */
test('an uninstall cannot look when Cursor is not installed, so it skips', async () => {
  const m = machine({ installed: false });

  assert.equal(await cursor.uninstall(m.ctx, m.opts), 'skipped');

  assert.deepEqual(m.kinds(), ['not-installed']);
});

test("detect and location answer about Cursor's own root", () => {
  const here = machine();
  const gone = machine({ installed: false });

  assert.equal(cursor.detect(here.opts), true);
  assert.equal(cursor.detect(gone.opts), false);
  assert.match(cursor.location(here.opts).toString(), /[/\\]\.cursor$/);
  assert.equal(cursor.needsSource, true, 'Cursor installs from files, so it needs them');
});
