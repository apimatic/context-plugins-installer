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
import type { Deps, HarnessName } from '../src/types.js';
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
  const result = await quietly(() =>
    uninstallPlugin({
      brand: brandFor(repo),
      plugin: 'future-sdk',
      deps: { fetchImpl: offline, env: {} },
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.targets, ['cursor']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).plugins;
  assert.deepEqual(after[0].targets, ['zed'], 'the foreign target stays on the record');
});
