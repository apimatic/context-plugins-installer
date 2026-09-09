import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VscodeHarness } from '../../src/harnesses/vscode.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import type { HarnessContext, HarnessEvent, HarnessOpts } from '../../src/types/harness.js';
import { toKey } from '../../src/types/vscode-settings.js';
import { cleanupAll, outcome, parseJsonc, plainly, tmpDir } from '../helpers.js';

test.after(cleanupAll);

const vscode = new VscodeHarness();
const PLUGIN = 'my-sdk';

interface MachineSpec {
  /** Whether VS Code's user directory exists at all. */
  installed?: boolean;
  /** settings.json content; `<DEST>` is replaced with the entry key. */
  settings?: string | null;
  /** Whether a copy of the plugin is already on disk. */
  copied?: boolean;
}

/**
 * A machine with VS Code's user dir and this tool's state dir. The copy lives
 * in the state dir, not in VS Code's storage, which is why uninstall needs no
 * detect() gate: the files are readable whether or not VS Code is here.
 */
function machine({ installed = true, settings = null, copied = false }: MachineSpec = {}) {
  const root = tmpDir('cp-vscode-');
  const env = {
    CP_STATE_DIR: path.join(root, 'state'),
    CP_VSCODE_USER_DIR: path.join(root, 'code-user'),
  };
  if (installed) fs.mkdirSync(env.CP_VSCODE_USER_DIR, { recursive: true });

  const src = path.join(root, 'source');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ name: PLUGIN }));

  const dest = path.join(env.CP_STATE_DIR, 'vscode', PLUGIN);
  if (copied) {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'plugin.json'), '{"name":"stale"}');
  }

  const file = path.join(env.CP_VSCODE_USER_DIR, 'settings.json');
  if (settings !== null) {
    fs.mkdirSync(env.CP_VSCODE_USER_DIR, { recursive: true });
    fs.writeFileSync(file, settings.replace('<DEST>', toKey(new DirectoryPath(dest))), 'utf8');
  }

  const events: HarnessEvent[] = [];
  const ctx: HarnessContext = {
    plugin: PLUGIN,
    marketplace: 'context-plugins',
    repo: 'apimatic/context-plugins',
    srcDir: new DirectoryPath(src),
    listener: (e) => events.push(e),
  };
  const opts: HarnessOpts = { env, home: root };
  return {
    ctx,
    opts,
    dest,
    file,
    events,
    kinds: (): string[] => events.map((e) => e.kind),
    entry: (): unknown =>
      fs.existsSync(file)
        ? parseJsonc(fs.readFileSync(file, 'utf8'))['chat.pluginLocations']?.[
            toKey(new DirectoryPath(dest))
          ]
        : undefined,
  };
}

const REGISTERED = '{\n  "chat.pluginLocations": { "<DEST>": true }\n}\n';
// A key the user has edited to something this tool did not write. VS Code may
// still be loading it, so it is never read as absence.
const HAND_EDITED = '{\n  "chat.pluginLocations": { "<DEST>": false }\n}\n';

test('a first install creates settings.json and registers the copy', async () => {
  const m = machine();

  assert.equal(outcome(await vscode.install(m.ctx, m.opts)), 'installed');

  assert.equal(m.entry(), true);
  assert.deepEqual(m.kinds(), ['copied', 'settings-registered', 'reload']);
});

test('an install into a settings file with other keys backs it up first', async () => {
  const m = machine({ settings: '{\n  "editor.fontSize": 12\n}\n' });

  assert.equal(outcome(await vscode.install(m.ctx, m.opts)), 'installed');

  assert.equal(m.entry(), true);
  assert.equal(parseJsonc(fs.readFileSync(m.file, 'utf8'))['editor.fontSize'], 12, 'kept');
  assert.deepEqual(m.kinds(), ['copied', 'settings-registered', 'settings-backed-up', 'reload']);
  const backups = fs.readdirSync(path.dirname(m.file)).filter((n) => n.includes('.bak-'));
  assert.equal(backups.length, 1, `one backup, got ${backups.join(', ')}`);
});

test('an install that is already registered says so and touches nothing', async () => {
  const m = machine({ settings: REGISTERED, copied: true });
  const before = fs.readFileSync(m.file, 'utf8');

  assert.equal(outcome(await vscode.install(m.ctx, m.opts)), 'installed');

  assert.equal(fs.readFileSync(m.file, 'utf8'), before, 'no rewrite for an entry already there');
  assert.deepEqual(m.kinds(), ['copied', 'settings-already', 'reload']);
});

/**
 * "Already registered" here would be a green install of a plugin VS Code never
 * loads, and splicing a second entry in would leave a duplicate key - so the
 * user is told exactly what to make it read.
 */
test('a hand-edited entry is a conflict, and the install still succeeds', async () => {
  const m = machine({ settings: HAND_EDITED });

  assert.equal(outcome(await vscode.install(m.ctx, m.opts)), 'installed');

  assert.ok(fs.existsSync(path.join(m.dest, 'plugin.json')), 'the files are in place either way');
  assert.equal(m.entry(), false, 'their entry is left as they wrote it');
  assert.deepEqual(m.kinds(), ['copied', 'settings-conflict', 'reload']);
});

// The files are in place, so this is a success with a caveat: reporting a skip
// would leave the copy on disk with nothing recorded to remove it.
test('a settings file with nothing to splice into is reported, not skipped', async () => {
  const m = machine({ settings: '// a file of nothing but comments\n' });

  assert.equal(outcome(await vscode.install(m.ctx, m.opts)), 'installed');

  assert.ok(fs.existsSync(path.join(m.dest, 'plugin.json')));
  assert.deepEqual(m.kinds(), ['copied', 'settings-failed', 'reload']);
  assert.deepEqual(plainly(m.events[1]), {
    harness: 'vscode',
    kind: 'settings-failed',
    settings: m.file,
    dest: m.dest,
  });
});

test('with VS Code not installed nothing is copied and the user dir is named', async () => {
  const m = machine({ installed: false });

  assert.equal(outcome(await vscode.install(m.ctx, m.opts)), 'skipped');

  assert.equal(fs.existsSync(m.dest), false);
  assert.deepEqual(plainly(m.events), [
    { harness: 'vscode', kind: 'not-installed', root: vscode.location(m.opts).toString() },
  ]);
});

test('with no source fetched the install skips rather than emptying the copy', async () => {
  const m = machine({ settings: REGISTERED, copied: true });

  assert.equal(outcome(await vscode.install({ ...m.ctx, srcDir: null }, m.opts)), 'skipped');

  assert.ok(fs.existsSync(m.dest), 'the existing copy is left alone');
  assert.deepEqual(m.kinds(), ['no-source']);
});

test('an uninstall removes the copy and unregisters it', async () => {
  const m = machine({ settings: REGISTERED, copied: true });

  assert.equal(await vscode.uninstall(m.ctx, m.opts), 'removed');

  assert.equal(fs.existsSync(m.dest), false);
  assert.equal(m.entry(), undefined);
  assert.deepEqual(m.kinds(), ['removed', 'settings-unregistered', 'settings-backed-up', 'reload']);
});

/**
 * Unmentioned, a leftover entry survives the uninstall and the next install
 * reports "Already registered" for something that never loads the plugin. The
 * record still follows the files: a stuck settings entry is a separate mess,
 * not a reason to keep claiming an install.
 */
test('an entry this tool did not write is always said, and does not fail the uninstall', async () => {
  const m = machine({ settings: HAND_EDITED, copied: true });

  assert.equal(await vscode.uninstall(m.ctx, m.opts), 'removed');

  assert.equal(fs.existsSync(m.dest), false, 'the copy still goes');
  assert.equal(m.entry(), false, 'nothing here can take their entry out safely');
  assert.deepEqual(m.kinds(), ['settings-unremovable', 'removed', 'reload']);
  assert.deepEqual(plainly(m.events[0]), {
    harness: 'vscode',
    kind: 'settings-unremovable',
    settings: m.file,
    dest: m.dest,
  });
});

// The outcome follows the files, so an entry with no copy is still a removal -
// there was something to take out, just not a directory.
test('an entry with no copy is unregistered, and says the copy was not there', async () => {
  const m = machine({ settings: REGISTERED });

  assert.equal(await vscode.uninstall(m.ctx, m.opts), 'removed');

  assert.equal(m.entry(), undefined);
  assert.deepEqual(m.kinds(), [
    'unregistered-only',
    'settings-unregistered',
    'settings-backed-up',
    'reload',
  ]);
});

test('an uninstall with nothing anywhere is absent, and says where it looked', async () => {
  const m = machine();

  assert.equal(await vscode.uninstall(m.ctx, m.opts), 'absent');

  assert.deepEqual(plainly(m.events), [
    { harness: 'vscode', kind: 'nothing-to-remove', dest: m.dest },
  ]);
});

/**
 * Unlike Cursor, whose copy sits inside Cursor's own root: this one is in the
 * state dir, so "there is nothing there" is established whether or not VS Code
 * is installed, and the row can be cleared.
 */
test('an uninstall answers absent even with no VS Code, because the copy is ours', async () => {
  const m = machine({ installed: false });

  assert.equal(await vscode.uninstall(m.ctx, m.opts), 'absent');

  assert.deepEqual(m.kinds(), ['nothing-to-remove']);
});

test("detect and location answer about VS Code's user directory", () => {
  const here = machine();
  const gone = machine({ installed: false });

  assert.equal(vscode.detect(here.opts), true);
  assert.equal(vscode.detect(gone.opts), false);
  assert.match(vscode.location(here.opts).toString(), /code-user$/);
  assert.equal(vscode.needsSource, true, 'VS Code installs from files, so it needs them');
});
