import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBrand } from '../src/brand.js';
import { rawUrl } from '../src/catalog.js';
import {
  installPlugin,
  uninstallPlugin,
  updateAll,
  listPlugins,
  chooseHarnesses,
} from '../src/install.js';
import * as manifest from '../src/manifest.js';
import * as paths from '../src/paths.js';
import type { Brand } from '../src/types/brand.js';
import type { HarnessName } from '../src/types/harness.js';
import type { Deps } from '../src/types/ports.js';
import { UserError, isPlainObject } from '../src/util.js';
import { tmpDir, cleanupAll, stubFetch, silenceConsole, parseJsonc } from './helpers.js';

test.after(cleanupAll);

// Claude Code is deliberately excluded from these targets: it shells out to a
// real `claude` binary that may be installed on the machine running the tests.
const TARGETS: HarnessName[] = ['cursor', 'vscode'];

/** A sandboxed machine: its own state dir, Cursor dir, and VS Code user dir. */
function machine() {
  const root = tmpDir('cp-machine-');
  const env = {
    CP_STATE_DIR: path.join(root, 'state'),
    CP_CURSOR_DIR: path.join(root, '.cursor'),
    CP_VSCODE_USER_DIR: path.join(root, 'code-user'),
  };
  fs.mkdirSync(env.CP_CURSOR_DIR, { recursive: true }); // Cursor "installed"
  fs.mkdirSync(env.CP_VSCODE_USER_DIR, { recursive: true }); // VS Code "installed"
  return { root, pathOpts: { env, home: root } };
}

/** A plugin folder as the marketplace would ship it. */
function pluginSource(name = 'my-sdk'): string {
  const dir = path.join(tmpDir('cp-plugin-'), name);
  fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'dotnet'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'skills', 'dotnet', 'SKILL.md'), '# dotnet skill');
  return dir;
}

interface DepsSpec {
  repo: string;
  marketplace?: string;
  plugin?: string;
  srcDir: string;
}

function deps({ repo, marketplace = 'apimatic', plugin = 'my-sdk', srcDir }: DepsSpec): Deps {
  return {
    fetchImpl: stubFetch({
      [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: {
        body: { name: marketplace, plugins: [{ name: plugin, source: `./plugins/${plugin}` }] },
      },
    }),
    env: {},
    materialize: async () => ({ dir: srcDir, cleanup: () => {}, via: 'stub' }),
  };
}

const brandFor = (repo: string) =>
  resolveBrand({ env: { CP_REPO: repo }, cwd: tmpDir('cp-cwd-'), home: tmpDir('cp-home-') });

/**
 * The same machine with a `claude` on PATH and a fake CLI behind it, so a test
 * can exercise the Claude Code path without touching a real binary.
 */
function withClaude(m: ReturnType<typeof machine>) {
  const bin = tmpDir('cp-bin-');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\n');
  const run = async (_file: string, args: string[]) => {
    const line = args.join(' ');
    // Nothing registered, nothing installed: every answer is a clean "not here".
    if (line.startsWith('plugin list')) return { code: 0, stdout: '[]', stderr: '' };
    if (line.startsWith('plugin marketplace list')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 1, stdout: '', stderr: 'not found in installed plugins' };
  };
  return {
    ...m,
    pathOpts: {
      ...m.pathOpts,
      env: { ...m.pathOpts.env, PATH: bin, PATHEXT: '.CMD' },
      run,
    },
  };
}

/** Console output as one line, with `log`'s column wrapping collapsed. */
const flat = (con: { lines: string[] }): string => con.lines.join(' ').replace(/\s+/g, ' ');

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const con = silenceConsole();
  try {
    return await fn();
  } finally {
    con.restore();
  }
}

test('install places files for every detected harness and records the manifest', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();

  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir }),
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.targets, ['cursor', 'vscode']);
  assert.equal(result.marketplace, 'apimatic', 'derived from the registry');

  const cursorDest = path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk');
  assert.ok(fs.existsSync(path.join(cursorDest, 'skills', 'dotnet', 'SKILL.md')));

  const vscodeDest = path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'my-sdk');
  assert.ok(fs.existsSync(path.join(vscodeDest, 'plugin.json')));

  const settings = parseJsonc(
    fs.readFileSync(path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json'), 'utf8'),
  );
  assert.equal(settings['chat.pluginLocations'][vscodeDest.replace(/\\/g, '/')], true);

  const recorded = manifest.list(paths.manifestPath(m.pathOpts));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].repo, repo);
  assert.deepEqual(recorded[0].targets, ['cursor', 'vscode']);
});

test('a second marketplace installs independently', async () => {
  const m = machine();
  const repo = 'acme/plugin-marketplace';
  const srcDir = pluginSource('acme-payments-sdk');

  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'acme-payments-sdk',
      targets: TARGETS,
      deps: deps({ repo, marketplace: 'acme', plugin: 'acme-payments-sdk', srcDir }),
      pathOpts: m.pathOpts,
    }),
  );

  assert.equal(result.marketplace, 'acme');
  const recorded = JSON.stringify(manifest.list(paths.manifestPath(m.pathOpts))).toLowerCase();
  assert.ok(
    !recorded.includes('apimatic'),
    `unexpected marketplace value in manifest: ${recorded}`,
  );
});

test('re-installing updates in place rather than duplicating', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const args = {
    brand: brandFor(repo),
    plugin: 'my-sdk',
    targets: TARGETS,
    deps: deps({ repo, srcDir }),
    pathOpts: m.pathOpts,
  };

  await quietly(() => installPlugin(args));
  await quietly(() => installPlugin(args));

  assert.equal(manifest.list(paths.manifestPath(m.pathOpts)).length, 1);
  const settings = fs.readFileSync(
    path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json'),
    'utf8',
  );
  const key = path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'my-sdk').replace(/\\/g, '/');
  assert.equal(settings.split(`"${key}"`).length - 1, 1, 'registered exactly once');
});

test('the same plugin id from a second marketplace is refused without --force', async () => {
  const m = machine();
  const srcDir = pluginSource();

  await quietly(() =>
    installPlugin({
      brand: brandFor('context-plugins/plugin-marketplace'),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo: 'context-plugins/plugin-marketplace', srcDir }),
      pathOpts: m.pathOpts,
    }),
  );

  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brandFor('acme/plugin-marketplace'),
        plugin: 'my-sdk',
        targets: TARGETS,
        deps: deps({ repo: 'acme/plugin-marketplace', marketplace: 'acme', srcDir }),
        pathOpts: m.pathOpts,
      }),
    ),
    (err) => err instanceof UserError && /different marketplace/.test(err.message),
  );
});

test('--force lets the second marketplace take over', async () => {
  const m = machine();
  const srcDir = pluginSource();
  await quietly(() =>
    installPlugin({
      brand: brandFor('context-plugins/plugin-marketplace'),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo: 'context-plugins/plugin-marketplace', srcDir }),
      pathOpts: m.pathOpts,
    }),
  );
  await quietly(() =>
    installPlugin({
      brand: brandFor('acme/plugin-marketplace'),
      plugin: 'my-sdk',
      targets: TARGETS,
      force: true,
      deps: deps({ repo: 'acme/plugin-marketplace', marketplace: 'acme', srcDir }),
      pathOpts: m.pathOpts,
    }),
  );
  assert.equal(manifest.list(paths.manifestPath(m.pathOpts)).length, 2);
});

test('uninstall removes the files, the settings entry, and the manifest row', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);

  await quietly(() =>
    installPlugin({
      brand,
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir }),
      pathOpts: m.pathOpts,
    }),
  );
  await quietly(() =>
    uninstallPlugin({
      brand,
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir }),
      pathOpts: m.pathOpts,
    }),
  );

  assert.ok(!fs.existsSync(path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk')));
  assert.ok(!fs.existsSync(path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'my-sdk')));
  assert.equal(manifest.list(paths.manifestPath(m.pathOpts)).length, 0);

  const settings = parseJsonc(
    fs.readFileSync(path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json'), 'utf8'),
  );
  assert.deepEqual(settings['chat.pluginLocations'], {});
});

// The record is the only thing wrong here: nothing is on disk to remove. Left
// on the row, the plugin could never be uninstalled and `update` would fail on
// it every run - so a clean machine and a stale row is a cleanup, not a failure.
test('a row nothing has installed is cleared rather than left stuck', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'ghost-sdk', repo, marketplace: 'apimatic', targets: TARGETS }],
    }),
  );

  const result = await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: TARGETS,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.targets, [], 'nothing was removed, because nothing was there');
  assert.equal(manifest.list(file).length, 0, 'and the row it drifted from is gone');
});

test('a target that could not be confirmed keeps the row until --force', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seed = () =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        plugins: [
          { plugin: 'ghost-sdk', repo, marketplace: 'apimatic', targets: ['claude', 'cursor'] },
        ],
      }),
    );
  seed();

  // An empty PATH is Claude Code out of reach: nothing can be said about it, so
  // its target stays on the record even though Cursor's is cleared.
  const offPath = { ...m.pathOpts, env: { ...m.pathOpts.env, PATH: '' } };
  const args = {
    brand: brandFor(repo),
    plugin: 'ghost-sdk',
    targets: ['claude', 'cursor'],
    deps: { fetchImpl: stubFetch({}), env: {} },
    pathOpts: offPath,
  };

  const con = silenceConsole();
  try {
    await uninstallPlugin(args);
  } finally {
    con.restore();
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plugins[0].targets, ['claude']);
  assert.match(con.lines.join(' '), /--force/, 'and the summary says how to clear it');

  seed();
  await quietly(() => uninstallPlugin({ ...args, force: true }));
  assert.equal(manifest.list(file).length, 0, '--force clears what could not be confirmed');
});

// Saying "cleared the stale record" while a target is still on it is the summary
// contradicting itself; a partial correction has to read as one.
test('a partial clear says which targets it cleared, not that the row is gone', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [
        { plugin: 'ghost-sdk', repo, marketplace: 'apimatic', targets: ['claude', 'cursor'] },
      ],
    }),
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: ['claude', 'cursor'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      // No PATH, so Claude Code cannot be asked and its target must stay.
      pathOpts: { ...m.pathOpts, env: { ...m.pathOpts.env, PATH: '' } },
    });
  } finally {
    con.restore();
  }
  const out = con.lines.join(' ');

  assert.match(out, /Nothing was installed in Cursor - cleared that from the record/);
  assert.doesNotMatch(out, /cleared the stale record/, 'the row is not gone');
  assert.match(out, /Still recorded for Claude Code/);
  // Exactly the target that is stuck - never the whole --targets of the run.
  assert.match(out, /--targets claude --force/);
  assert.doesNotMatch(out, /--targets claude,cursor/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plugins[0].targets, ['claude']);
});

test('--force names what it dropped without confirming', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'ghost-sdk', repo, marketplace: 'apimatic', targets: ['claude'] }],
    }),
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: ['claude'],
      force: true,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: { ...m.pathOpts, env: { ...m.pathOpts.env, PATH: '' } },
    });
  } finally {
    con.restore();
  }

  const out = con.lines.join(' ');
  assert.match(out, /Dropped from the record without confirming removal: Claude Code/);
  // Nothing looked, so no line may report a finding - in either direction.
  assert.doesNotMatch(out, /cleared the stale record|Nothing was installed/);
  assert.doesNotMatch(out, /Nothing was changed/);
  assert.equal(manifest.list(file).length, 0);
});

// One editor removed and another found empty are two different things, and the
// row is gone either way - so the summary has to say both.
test('a removal does not hide a target cleared alongside it', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const dest = path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'mix-sdk');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'plugin.json'), '{}');
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'mix-sdk', repo, marketplace: 'apimatic', targets: TARGETS }],
    }),
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'mix-sdk',
      targets: TARGETS,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }

  const out = con.lines.join(' ');
  assert.match(out, /Uninstalled from: Cursor/);
  assert.match(out, /Nothing was installed in VS Code - cleared that from the record/);
  assert.equal(manifest.list(file).length, 0);
});

// Cursor's plugin dir lives inside Cursor's own root, so a missing root is not
// an empty one - clearing the record off a path the install may never have used
// would strand the copy it did use.
test('an editor that is not installed leaves its target recorded', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'ghost-sdk', repo, marketplace: 'apimatic', targets: ['cursor'] }],
    }),
  );

  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: ['cursor'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(manifest.list(file)[0].targets, ['cursor'], 'nothing could be established');
});

// No plugin files means nothing for VS Code to load, whatever settings.json
// still says - so the record clears. The leftover entry is a separate mess, and
// has to be named: unmentioned, it survives and the next install reports
// "Already registered" for an entry that never loads the plugin.
test('an unrecognised settings entry is reported, not silently kept or hidden', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const dest = path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'ghost-sdk');
  const settings = path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json');
  const source = `{\n  "chat.pluginLocations": {\n    "${dest.replace(/\\/g, '/')}": false\n  }\n}\n`;
  fs.writeFileSync(settings, source);
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'ghost-sdk', repo, marketplace: 'apimatic', targets: ['vscode'] }],
    }),
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: ['vscode'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }

  assert.equal(manifest.list(file).length, 0, 'no files means nothing is installed');
  assert.equal(fs.readFileSync(settings, 'utf8'), source, 'the entry is left for the user');
  assert.match(flat(con), /in a form this tool did not write/);
});

// The same entry with the files still present: the removal succeeds, and the
// leftover entry must still be named rather than riding along unmentioned.
test('an unrecognised settings entry is named even when the files did go', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const dest = path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'ghost-sdk');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'plugin.json'), '{}');
  const settings = path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json');
  fs.writeFileSync(
    settings,
    `{\n  "chat.pluginLocations": {\n    "${dest.replace(/\\/g, '/')}": false\n  }\n}\n`,
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: ['vscode'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }

  assert.ok(!fs.existsSync(dest));
  assert.match(flat(con), /in a form this tool did not write/, 'said, not swallowed');
});

// A throw must not cost the removals already done: leaving them recorded is the
// stranding this whole path exists to prevent.
test('a harness that throws still records what was already removed', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);
  const d = deps({ repo, srcDir });

  await quietly(() =>
    installPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: d, pathOpts: m.pathOpts }),
  );

  // A directory where settings.json belongs: readFileSync throws EISDIR, so the
  // VS Code harness fails after Cursor has already been cleaned up.
  const settings = path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json');
  fs.rmSync(settings, { force: true });
  fs.mkdirSync(settings, { recursive: true });

  const file = paths.manifestPath(m.pathOpts);
  const con = silenceConsole();
  await assert.rejects(
    (async () => {
      try {
        await uninstallPlugin({
          brand,
          plugin: 'my-sdk',
          targets: TARGETS,
          deps: d,
          pathOpts: m.pathOpts,
        });
      } finally {
        con.restore();
      }
    })(),
    'the failure still reaches the caller',
  );

  assert.ok(!fs.existsSync(path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk')));
  assert.deepEqual(
    manifest.list(file)[0].targets,
    ['vscode'],
    'Cursor is off the record, VS Code is still on it',
  );
  assert.match(
    con.lines.join(' '),
    /Uninstalled from: Cursor/,
    'the throw is caught per editor, so the run still reaches its summary',
  );
});

test('a row whose targets this build cannot read is left exactly as found', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A newer CLI models targets some other way; the row is its business.
  const row = { plugin: 'future-sdk', repo, marketplace: 'apimatic', targets: { cursor: {} } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, plugins: [row] }));

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'future-sdk',
      targets: ['cursor'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plugins, [row], 'untouched');
  const out = con.lines.join(' ');
  assert.match(out, /has a target list this version cannot read/);
  assert.match(out, /--force/, 'and there is a way out of it');

  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'future-sdk',
      targets: ['cursor'],
      force: true,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plugins, [], '--force takes it');
});

// The regression this pair guards: a row with no target list at all was left on
// disk by every uninstall, --force included, while `read()` filed it under
// `ignored` - so `update` failed on it on every future run, forever.
test('a row that names no editor is dropped once every editor has answered', async () => {
  const m = withClaude(machine());
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'no-targets-sdk', repo, marketplace: 'apimatic' }],
    }),
  );

  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'no-targets-sdk',
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );

  assert.equal(manifest.read(file).ignored.length, 0, 'and `update` stops failing on it');
  assert.equal(manifest.list(file).length, 0);
});

// The row this branch's own rewrite produces: uninstalling Cursor from
// `['cursor','zed']` leaves `['zed']`, which no target list this build reads can
// shorten. Left as a `list` it could never be dropped - not even with --force -
// while `read()` filed it under `ignored` and `update` failed on it forever.
test('a row naming only targets this build does not know has a way out', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { plugin: 'zed-sdk', repo, marketplace: 'apimatic', targets: ['zed'] };
  fs.writeFileSync(file, JSON.stringify({ version: 1, plugins: [row] }));

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'zed-sdk',
      targets: TARGETS,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).plugins,
    [row],
    "never dropped on an inference - it is another tool's list",
  );
  assert.match(flat(con), /target list this version cannot read/);
  assert.match(flat(con), /--force/, 'but it is not a dead end');

  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'zed-sdk',
      targets: TARGETS,
      force: true,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );
  assert.equal(manifest.read(file).ignored.length, 0, '--force takes it');
});

// `targets: []` reads as "every harness", so one editor's answer cannot settle
// the whole row - the copy another editor still holds would be stranded.
test('a scoped run never drops a row that stands for every editor', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const vscodeCopy = path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'x-sdk');
  fs.mkdirSync(vscodeCopy, { recursive: true });
  fs.writeFileSync(path.join(vscodeCopy, 'plugin.json'), '{}');
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'x-sdk', repo, marketplace: 'apimatic', targets: [] }],
    }),
  );

  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'x-sdk',
      targets: ['cursor'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );

  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).plugins.length,
    1,
    'only Cursor was asked, and the VS Code copy is still on disk',
  );
  assert.ok(fs.existsSync(vscodeCopy));
});

// A --force that leaves targets on the row has to say so, and every earlier
// shape of this printed "Nothing was changed" instead.
test('--force still reports what it left behind', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'y-sdk', repo, marketplace: 'apimatic', targets: ['claude'] }],
    }),
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'y-sdk',
      targets: ['cursor'],
      force: true,
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }

  const out = flat(con);
  assert.match(out, /Still recorded for Claude Code/);
  assert.doesNotMatch(out, /Nothing was changed/, 'the row survived, and it says which part');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plugins[0].targets, ['claude']);
});

test('a row that names no editor survives an editor that could not answer', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `targets: []` reads as "every harness", so it is this same shape.
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'empty-sdk', repo, marketplace: 'apimatic', targets: [] }],
    }),
  );

  const con = silenceConsole();
  try {
    await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'empty-sdk',
      targets: ['cursor'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }

  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).plugins.length,
    1,
    'Cursor could not be looked at, so nothing established the row is stale',
  );
  assert.doesNotMatch(con.lines.join(' '), /cleared|dropped it/i);
});

test('an editor that is simply not here does not fail the run', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });
  const repo = 'context-plugins/plugin-marketplace';

  const result = await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      targets: ['cursor'],
      deps: { fetchImpl: stubFetch({}), env: {} },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.failed, [], 'a skip is not a failure');
});

test('an editor that was asked and went wrong fails the run', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  // A directory where settings.json belongs: readFileSync throws EISDIR.
  const settings = path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json');
  fs.rmSync(settings, { force: true });
  fs.mkdirSync(settings, { recursive: true });

  await assert.rejects(
    quietly(() =>
      uninstallPlugin({
        brand: brandFor(repo),
        plugin: 'ghost-sdk',
        targets: ['vscode'],
        deps: { fetchImpl: stubFetch({}), env: {} },
        pathOpts: m.pathOpts,
      }),
    ),
    /Could not uninstall/,
  );
});

// --force is the documented escape for a row nothing can clear, so nothing about
// reaching the registry may stand between the user and using it.
test('--force clears a record offline, with no marketplace to resolve', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // No `marketplace` and no `targets`: the shape --force exists for.
  fs.writeFileSync(file, JSON.stringify({ version: 1, plugins: [{ plugin: 'ghost-sdk', repo }] }));
  const offline = () => {
    throw new Error('network touched');
  };

  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'ghost-sdk',
      force: true,
      deps: { fetchImpl: offline, env: {} },
      pathOpts: { ...m.pathOpts, env: { ...m.pathOpts.env, PATH: '' } },
    }),
  );

  assert.equal(manifest.list(file).length, 0);
});

test('a lookup failure still stops an uninstall with no record to correct', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const offline = () => {
    throw new Error('network touched');
  };

  await assert.rejects(
    quietly(() =>
      uninstallPlugin({
        brand: brandFor(repo),
        plugin: 'never-installed-sdk',
        deps: { fetchImpl: offline, env: {} },
        pathOpts: m.pathOpts,
      }),
    ),
    'the resolution error is the useful answer when there is nothing to clean up',
  );
});

// `update` refreshing a plugin for an editor that is no longer installed is a
// no-op, not a failure - otherwise the row makes `update` exit 1 forever, and
// this branch made such a row need --force to clear.
test('update skips a row whose editors are all gone instead of failing', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);
  const d = deps({ repo, srcDir });

  await quietly(() =>
    installPlugin({ brand, plugin: 'my-sdk', targets: ['cursor'], deps: d, pathOpts: m.pathOpts }),
  );
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });

  const result = await quietly(() => updateAll({ brand, deps: d, pathOpts: m.pathOpts }));

  assert.deepEqual(result.failed, [], 'no editor for it is not a failure');
  assert.deepEqual(result.updated, []);
});

test('asking for an editor that is not installed fails, naming it', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });
  const repo = 'context-plugins/plugin-marketplace';

  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brandFor(repo),
        plugin: 'my-sdk',
        targets: ['cursor'],
        deps: deps({ repo, srcDir: pluginSource() }),
        pathOpts: m.pathOpts,
      }),
    ),
    (err) =>
      err instanceof UserError &&
      /Cursor is not installed/.test(err.message) &&
      /--targets/.test(err.hint ?? ''),
  );
});

test('no editor at all fails rather than silently doing nothing', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });
  fs.rmSync(m.pathOpts.env.CP_VSCODE_USER_DIR, { recursive: true, force: true });
  const repo = 'context-plugins/plugin-marketplace';

  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brandFor(repo),
        plugin: 'my-sdk',
        targets: TARGETS,
        deps: deps({ repo, srcDir: pluginSource() }),
        pathOpts: m.pathOpts,
      }),
    ),
    (err) => err instanceof UserError && /not installed on this machine/.test(err.message),
  );
});

test('a harness that is not installed is skipped, not failed', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true }); // Cursor absent
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();

  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir }),
      pathOpts: m.pathOpts,
    }),
  );
  assert.deepEqual(result.targets, ['vscode']);
});

// ---- harness consent -----------------------------------------------------

type Confirm = NonNullable<Deps['confirm']> & { asked: string[] };

/** Records what was asked, and answers from a scripted list of booleans. */
function scriptedConfirm(answers: boolean[]): Confirm {
  const asked: string[] = [];
  const fn = async (question: string): Promise<boolean> => {
    asked.push(question);
    return answers.shift() ?? true;
  };
  return Object.assign(fn, { asked });
}

test('the user is asked once per detected harness', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const confirm = scriptedConfirm([true, true]);

  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null, // no --targets => ask
      deps: { ...deps({ repo, srcDir }), confirm },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(confirm.asked, ['Install into Cursor?', 'Install into VS Code?']);
  assert.deepEqual(result.targets, ['cursor', 'vscode']);
});

test('a declined harness is not touched', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();

  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: { ...deps({ repo, srcDir }), confirm: scriptedConfirm([false, true]) },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.targets, ['vscode']);
  assert.ok(
    !fs.existsSync(path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk')),
    'declined harness got no files',
  );
  assert.ok(fs.existsSync(path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'my-sdk')));
  assert.deepEqual(manifest.list(paths.manifestPath(m.pathOpts))[0].targets, ['vscode']);
});

test('declining an editor it is ALREADY installed in keeps the record and the files', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const d = deps({ repo, srcDir });
  const args = { brand: brandFor(repo), plugin: 'my-sdk', deps: d, pathOpts: m.pathOpts };
  const vscodeDest = path.join(m.pathOpts.env.CP_STATE_DIR, 'vscode', 'my-sdk');
  const settingsFile = path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json');

  // Installed into both to begin with.
  await quietly(() => installPlugin({ ...args, targets: TARGETS }));
  assert.deepEqual(manifest.list(paths.manifestPath(m.pathOpts))[0].targets, ['cursor', 'vscode']);

  // Re-install, saying yes to Cursor and no to VS Code.
  const result = await quietly(() =>
    installPlugin({
      ...args,
      targets: null,
      deps: { ...d, confirm: scriptedConfirm([true, false]) },
    }),
  );

  assert.deepEqual(result.targets, ['cursor'], 'only Cursor was installed into this run');
  assert.deepEqual(result.untouched, ['vscode'], 'VS Code reported as left alone');

  // The record still names VS Code, so `update` keeps refreshing that copy.
  assert.deepEqual(
    manifest.list(paths.manifestPath(m.pathOpts))[0].targets,
    ['cursor', 'vscode'],
    'the declined editor stays on record',
  );

  // And the declined copy is genuinely untouched, not removed.
  assert.ok(fs.existsSync(path.join(vscodeDest, 'plugin.json')), 'VS Code files still there');
  const settings = parseJsonc(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(
    settings['chat.pluginLocations'][vscodeDest.replace(/\\/g, '/')],
    true,
    'still registered',
  );
});

test('the declined-but-installed editor is named once, in the summary', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const d = deps({ repo, srcDir });
  const args = { brand: brandFor(repo), plugin: 'my-sdk', deps: d, pathOpts: m.pathOpts };

  await quietly(() => installPlugin({ ...args, targets: TARGETS }));

  const con = silenceConsole();
  try {
    await installPlugin({
      ...args,
      targets: null,
      deps: { ...d, confirm: scriptedConfirm([true, false]) },
    });
  } finally {
    con.restore();
  }
  // Colour is off without a TTY, but strip it anyway so FORCE_COLOR cannot break this.
  const out = con.lines.join('\n').replace(/\x1b\[\d+m/g, '');

  assert.match(out, /Already installed: VS Code/);
  // Said once, in the summary - not again up in [Harnesses].
  assert.equal(out.match(/Already installed/g)?.length, 1, 'said exactly once');
  assert.doesNotMatch(out, /not removed/);
  assert.doesNotMatch(out, /--targets vscode/);
});

test('a fresh install records only what it installed', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: { ...deps({ repo, srcDir }), confirm: scriptedConfirm([true, false]) },
      pathOpts: m.pathOpts,
    }),
  );

  // No prior record, so nothing to preserve - the union must not invent a target.
  assert.deepEqual(manifest.list(paths.manifestPath(m.pathOpts))[0].targets, ['cursor']);
});

test('declining everything changes nothing at all', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();

  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: { ...deps({ repo, srcDir }), confirm: scriptedConfirm([false, false]) },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.targets, []);
  assert.equal(manifest.list(paths.manifestPath(m.pathOpts)).length, 0, 'no manifest entry');
  assert.ok(!fs.existsSync(path.join(m.pathOpts.env.CP_VSCODE_USER_DIR, 'settings.json')));
});

test('an undetected harness is never offered', async () => {
  const m = machine();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const confirm = scriptedConfirm([true]);

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: { ...deps({ repo, srcDir }), confirm },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(confirm.asked, ['Install into VS Code?'], 'Cursor absent, so not offered');
});

test('nothing is downloaded when every harness is declined', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  let fetched = false;

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: {
        ...deps({ repo, srcDir: pluginSource() }),
        materialize: async () => {
          fetched = true;
          throw new Error('should not fetch');
        },
        confirm: scriptedConfirm([false, false]),
      },
      pathOpts: m.pathOpts,
    }),
  );

  assert.equal(fetched, false, 'the prompt runs before the download');
});

test('--targets is a decision, so it skips the prompt', async () => {
  const confirm = scriptedConfirm([]);
  const chosen = await chooseHarnesses(TARGETS, { explicit: true, confirm });
  assert.deepEqual(chosen, ['cursor', 'vscode']);
  assert.deepEqual(confirm.asked, []);
});

test('--yes skips the prompt', async () => {
  const confirm = scriptedConfirm([]);
  const chosen = await chooseHarnesses(TARGETS, { assumeYes: true, confirm });
  assert.deepEqual(chosen, ['cursor', 'vscode']);
  assert.deepEqual(confirm.asked, []);
});

test('update never re-asks, it replays the recorded harnesses', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const d = deps({ repo, srcDir });

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: { ...d, confirm: scriptedConfirm([false, true]) },
      pathOpts: m.pathOpts,
    }),
  );

  const confirm = scriptedConfirm([]);
  await quietly(() =>
    updateAll({ brand: brandFor(repo), deps: { ...d, confirm }, pathOpts: m.pathOpts }),
  );

  assert.deepEqual(confirm.asked, []);
  assert.deepEqual(manifest.list(paths.manifestPath(m.pathOpts))[0].targets, ['vscode']);
});

test('update names the targets it cannot update, and leaves them recorded', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const d = deps({ repo, srcDir: pluginSource() });
  const file = paths.manifestPath(m.pathOpts);

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );
  // As if a newer CLI had installed the same plugin into an editor this build
  // knows nothing about.
  const raw = manifest.findRaw(file, { plugin: 'my-sdk', repo });
  assert.ok(raw);
  manifest.upsert(file, { ...raw, targets: [...TARGETS, 'zed'] });

  const con = silenceConsole();
  try {
    await updateAll({ brand: brandFor(repo), deps: d, pathOpts: m.pathOpts });
  } finally {
    con.restore();
  }

  const out = con.lines
    .join(' ')
    .replace(/\x1b\[\d+m/g, '')
    .split(' ')
    .filter(Boolean)
    .join(' ');
  assert.ok(out.includes('not updating unknown target(s): zed'), `no such warning in: ${out}`);
  assert.deepEqual(
    manifest.foreignTargets(manifest.findRaw(file, { plugin: 'my-sdk', repo })),
    ['zed'],
    'and the update wrote it back untouched',
  );
});

test('update reads the registry once for the whole run, not once per plugin', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const registry = rawUrl(repo, 'main', '.claude-plugin/marketplace.json');
  const fetchImpl = stubFetch({
    [registry]: {
      body: {
        name: 'apimatic',
        plugins: [
          { name: 'alpha', source: './plugins/alpha' },
          { name: 'beta', source: './plugins/beta' },
        ],
      },
    },
  });
  const d: Deps = {
    fetchImpl,
    env: {},
    materialize: async ({ sourcePath }) => ({
      dir: pluginSource(sourcePath.split('/').pop()),
      cleanup: () => {},
      via: 'stub',
    }),
  };

  for (const plugin of ['alpha', 'beta']) {
    await quietly(() =>
      installPlugin({
        brand: brandFor(repo),
        plugin,
        targets: TARGETS,
        deps: d,
        pathOpts: m.pathOpts,
      }),
    );
  }

  const before = fetchImpl.calls.filter((u) => u === registry).length;
  const result = await quietly(() =>
    updateAll({ brand: brandFor(repo), deps: d, pathOpts: m.pathOpts }),
  );

  const during = fetchImpl.calls.filter((u) => u === registry).length - before;
  assert.deepEqual(result.updated.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.failed, []);
  assert.equal(during, 1, `expected one registry read for two plugins, got ${during}`);
});

test('list marks what is installed on this machine', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);
  const d = deps({ repo, srcDir });

  await quietly(() =>
    installPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: d, pathOpts: m.pathOpts }),
  );
  const listing = await listPlugins({ brand, deps: d, pathOpts: m.pathOpts });

  assert.equal(listing.marketplace, 'apimatic');
  assert.deepEqual(
    listing.plugins.map((p) => [p.name, p.installed]),
    [['my-sdk', true]],
  );
});

test('list reports the editors a plugin was actually installed into', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);
  const d = deps({ repo, srcDir });

  // Installed into Cursor only - VS Code never got a copy.
  await quietly(() =>
    installPlugin({ brand, plugin: 'my-sdk', targets: ['cursor'], deps: d, pathOpts: m.pathOpts }),
  );

  const listing = await listPlugins({ brand, deps: d, pathOpts: m.pathOpts });
  assert.deepEqual(listing.plugins[0].targets, ['cursor']);
  assert.equal(listing.plugins[0].installed, true, 'installed somewhere');
});

test('update fails loudly on rows it cannot read instead of skipping them', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const d = deps({ repo, srcDir });

  // One good install on record, plus a row only a newer CLI understands.
  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );
  const file = paths.manifestPath(m.pathOpts);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.plugins.push({ plugin: 'future-sdk', repo, marketplace: 'apimatic', targets: ['zed'] });
  fs.writeFileSync(file, JSON.stringify(raw));

  const result = await quietly(() =>
    updateAll({ brand: brandFor(repo), deps: d, pathOpts: m.pathOpts }),
  );

  assert.deepEqual(result.updated, ['my-sdk']);
  assert.equal(result.failed.length, 1, 'the unreadable row is a failure, not a silent skip');
  assert.equal(result.failed[0].plugin, 'future-sdk');
  assert.match(result.failed[0].error, /unknown target\(s\): zed/);

  const after: unknown[] = JSON.parse(fs.readFileSync(file, 'utf8')).plugins;
  assert.ok(
    after.some((p) => isPlainObject(p) && p.plugin === 'future-sdk'),
    'the row survives the update rewrite',
  );
});

test('uninstall still works offline for rows the sanitized view hides', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const file = paths.manifestPath(m.pathOpts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [
        { plugin: 'future-sdk', repo, marketplace: 'apimatic', targets: ['zed', 'cursor'] },
      ],
    }),
  );
  const cursorCopy = path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'future-sdk');
  fs.mkdirSync(cursorCopy, { recursive: true });
  fs.writeFileSync(path.join(cursorCopy, 'plugin.json'), '{}');

  // Any fetch is a test failure: the recorded marketplace must keep this offline.
  const offline = () => {
    throw new Error('network touched');
  };
  const con = silenceConsole();
  let result;
  try {
    result = await uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'future-sdk',
      deps: { fetchImpl: offline, env: {} },
      pathOpts: m.pathOpts,
    });
  } finally {
    con.restore();
  }
  const out = con.lines.join(' ');

  assert.deepEqual(result.targets, ['cursor']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).plugins;
  assert.deepEqual(after[0].targets, ['zed'], 'the foreign target stays on the record');
  // The row that is left names nothing this build knows, so it has to say so -
  // silently, `read()` files it under `ignored` and `update` fails on it forever.
  assert.match(out, /target list this version cannot read/);
  assert.match(out, /--force/, 'and names the one thing that clears it');
});

test('a row mixing a known target with a foreign one keeps the foreign name', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);
  const d = deps({ repo, srcDir });

  await quietly(() =>
    installPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: d, pathOpts: m.pathOpts }),
  );

  // A newer CLI adds its own harness to the row, and a field this build has
  // never heard of. Both belong to it, not to us.
  const file = paths.manifestPath(m.pathOpts);
  const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
  seeded.plugins[0].targets.push('zed');
  seeded.plugins[0].pinned = true;
  fs.writeFileSync(file, JSON.stringify(seeded));

  const result = await quietly(() => updateAll({ brand, deps: d, pathOpts: m.pathOpts }));
  assert.deepEqual(result.updated, ['my-sdk'], 'this build still refreshes what it owns');

  const after = JSON.parse(fs.readFileSync(file, 'utf8')).plugins[0];
  assert.deepEqual(after.targets, [...TARGETS, 'zed'], 'known names canonical, foreign kept');
  assert.equal(after.pinned, true, 'and so is a field this build does not model');
});

interface Tracked {
  name: string;
  properties: Record<string, unknown>;
}

/** The deps for an install, plus a track seam that collects into `events`. */
function tracking(spec: DepsSpec, events: Tracked[]): Deps {
  return {
    ...deps(spec),
    track: (name, properties = {}) => {
      events.push({ name, properties });
    },
  };
}

test('install reports one event per editor through the track seam, flat and without paths', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const events: Tracked[] = [];
  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: tracking({ repo, srcDir: pluginSource() }, events),
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(
    events.map((e) => [e.name, e.properties.harness]),
    [
      ['Context Plugin Installed', 'cursor'],
      ['Context Plugin Installed', 'vscode'],
    ],
  );
  for (const e of events) {
    assert.equal(e.properties.plugin, 'my-sdk');
    assert.equal(e.properties.marketplace, repo, 'the built-in marketplace is named');
    assert.equal(e.properties.targets_explicit, true);
    assert.equal(typeof e.properties.duration_ms, 'number');
    const serialized = JSON.stringify(e);
    const escapedRoot = JSON.stringify(m.root).slice(1, -1);
    assert.ok(!serialized.includes(escapedRoot), 'no path from this machine');
    for (const value of Object.values(e.properties)) {
      assert.ok(value === null || typeof value !== 'object', 'every property is a primitive');
    }
  }
});

test('a custom marketplace is reported as "custom"; a failure as its stage and kind, never its message', async () => {
  const m = machine();
  const repo = 'acme/plugin-marketplace';
  const events: Tracked[] = [];
  const spec = { repo, marketplace: 'acme', plugin: 'acme-sdk', srcDir: pluginSource('acme-sdk') };

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'acme-sdk',
      targets: TARGETS,
      deps: tracking(spec, events),
      pathOpts: m.pathOpts,
    }),
  );
  assert.equal(events[0]?.properties.marketplace, 'custom');

  events.length = 0;
  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brandFor(repo),
        plugin: 'missing-sdk',
        targets: TARGETS,
        deps: tracking(spec, events),
        pathOpts: m.pathOpts,
      }),
    ),
    UserError,
  );
  assert.deepEqual(
    events.map((e) => e.name),
    ['Context Plugin Install Failed'],
  );
  assert.equal(events[0]?.properties.plugin, 'missing-sdk');
  assert.equal(events[0]?.properties.stage, 'resolve');
  assert.equal(events[0]?.properties.error_kind, 'user');
  assert.ok(!JSON.stringify(events[0]).includes('not listed'), 'the message stays home');

  // An id that failed validation is not echoed back either.
  events.length = 0;
  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brandFor(repo),
        plugin: '../etc',
        targets: TARGETS,
        deps: tracking(spec, events),
        pathOpts: m.pathOpts,
      }),
    ),
    UserError,
  );
  assert.equal(events[0]?.properties.plugin, null);
});

test('uninstall reports one event per editor it removed', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const events: Tracked[] = [];
  const d = tracking({ repo, srcDir: pluginSource() }, events);
  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );

  events.length = 0;
  await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );
  assert.deepEqual(
    events.map((e) => [e.name, e.properties.harness, e.properties.plugin]),
    [
      ['Context Plugin Uninstalled', 'cursor', 'my-sdk'],
      ['Context Plugin Uninstalled', 'vscode', 'my-sdk'],
    ],
  );
});

test('a throwing track sink, or a Brand without telemetry config, never fails an install', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const spec = { repo, srcDir: pluginSource() };
  const throwing: Deps = {
    ...deps(spec),
    track: () => {
      throw new Error('sink is down');
    },
  };
  const result = await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: throwing,
      pathOpts: m.pathOpts,
    }),
  );
  assert.deepEqual(result.targets, ['cursor', 'vscode']);

  // A Brand built by an older caller has no telemetry field at all.
  const legacy = { ...brandFor(repo), telemetry: undefined } as unknown as Brand;
  const events: Tracked[] = [];
  const again = await quietly(() =>
    installPlugin({
      brand: legacy,
      plugin: 'my-sdk',
      targets: TARGETS,
      force: true,
      deps: tracking(spec, events),
      pathOpts: m.pathOpts,
    }),
  );
  assert.deepEqual(again.targets, ['cursor', 'vscode']);
  assert.equal(events[0]?.properties.marketplace, 'custom');
});
