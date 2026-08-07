'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  installPlugin,
  uninstallPlugin,
  listPlugins,
  chooseHarnesses,
  updateAll,
} = require('../src/install');
const { resolveBrand } = require('../src/brand');
const { rawUrl } = require('../src/catalog');
const manifest = require('../src/manifest');
const paths = require('../src/paths');
const { UserError } = require('../src/util');
const { tmpDir, cleanupAll, stubFetch, silenceConsole, parseJsonc } = require('./helpers');

test.after(cleanupAll);

// Claude Code is deliberately excluded from these targets: it shells out to a
// real `claude` binary that may be installed on the machine running the tests.
const TARGETS = ['cursor', 'vscode'];

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
function pluginSource(name = 'my-sdk') {
  const dir = path.join(tmpDir('cp-plugin-'), name);
  fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'dotnet'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'skills', 'dotnet', 'SKILL.md'), '# dotnet skill');
  return dir;
}

function deps({ repo, marketplace = 'apimatic', plugin = 'my-sdk', srcDir }) {
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

const brandFor = (repo) =>
  resolveBrand({ env: { CP_REPO: repo }, cwd: tmpDir('cp-cwd-'), home: tmpDir('cp-home-') });

async function quietly(fn) {
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
  assert.ok(!recorded.includes('apimatic'), `unexpected marketplace value in manifest: ${recorded}`);
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
    installPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: deps({ repo, srcDir }), pathOpts: m.pathOpts }),
  );
  await quietly(() =>
    uninstallPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: deps({ repo, srcDir }), pathOpts: m.pathOpts }),
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
      /--targets/.test(err.hint),
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

/** Records what was asked, and answers from a scripted list of booleans. */
function scriptedConfirm(answers) {
  const asked = [];
  const fn = async (question) => {
    asked.push(question);
    return answers.length ? answers.shift() : true;
  };
  fn.asked = asked;
  return fn;
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
    installPlugin({ ...args, targets: null, deps: { ...d, confirm: scriptedConfirm([true, false]) } }),
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
  assert.equal(settings['chat.pluginLocations'][vscodeDest.replace(/\\/g, '/')], true, 'still registered');
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
    await installPlugin({ ...args, targets: null, deps: { ...d, confirm: scriptedConfirm([true, false]) } });
  } finally {
    con.restore();
  }
  // Colour is off without a TTY, but strip it anyway so FORCE_COLOR cannot break this.
  const out = con.lines.join('\n').replace(/\x1b\[\d+m/g, '');

  assert.match(out, /Already installed: VS Code/);
  // One line, in the summary - nothing up in [Harnesses]. The earlier version said it
  // twice and ran to four wrapped lines, which buried the install report itself.
  assert.equal(out.match(/Already installed/g).length, 1, 'said exactly once');
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
  const chosen = await chooseHarnesses(['cursor', 'vscode'], { explicit: true, confirm });
  assert.deepEqual(chosen, ['cursor', 'vscode']);
  assert.deepEqual(confirm.asked, []);
});

test('--yes skips the prompt', async () => {
  const confirm = scriptedConfirm([]);
  const chosen = await chooseHarnesses(['cursor', 'vscode'], { assumeYes: true, confirm });
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
  const { updateAll } = require('../src/install');
  await quietly(() => updateAll({ brand: brandFor(repo), deps: { ...d, confirm }, pathOpts: m.pathOpts }));

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
  const d = {
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
  const { updateAll } = require('../src/install');
  const result = await quietly(() =>
    updateAll({ brand: brandFor(repo), deps: d, pathOpts: m.pathOpts }),
  );

  const during = fetchImpl.calls.filter((u) => u === registry).length - before;
  assert.deepEqual(result.updated.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.failed, []);
  assert.equal(during, 1, `expected one registry read for two plugins, got ${during}`);
});

/** Like quietly(), but hands back what was printed so wording can be asserted. */
async function capture(fn) {
  const con = silenceConsole();
  try {
    return { result: await fn(), out: con.lines.join('\n') };
  } finally {
    con.restore();
  }
}

test('update skips a plugin the marketplace no longer lists', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const brand = brandFor(repo);

  await quietly(() =>
    installPlugin({
      brand,
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir: pluginSource() }),
      pathOpts: m.pathOpts,
    }),
  );

  // The marketplace now carries a different plugin under a different id. That is
  // a new plugin, not the same one renamed, so nothing here can refresh my-sdk.
  const relisted = deps({ repo, plugin: 'my-sdk-v2', srcDir: pluginSource('my-sdk-v2') });
  const { result, out } = await capture(() =>
    updateAll({ brand, deps: relisted, pathOpts: m.pathOpts }),
  );

  assert.deepEqual(result.failed, [], 'a de-listed plugin is not a failure');
  assert.deepEqual(result.skipped, ['my-sdk']);
  assert.deepEqual(result.updated, []);
  assert.match(out, /no longer supported by Context Plugins/);
  assert.match(out, /uninstall my-sdk/, 'the way out is named');

  assert.ok(
    fs.existsSync(path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk')),
    'the files were left exactly where they were',
  );
  assert.equal(
    manifest.list(paths.manifestPath(m.pathOpts)).length,
    1,
    'the record survives, so uninstall still works',
  );
});

test('a de-listed plugin does not stop the rest of the run', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const brand = brandFor(repo);
  const listed = {
    name: 'apimatic',
    plugins: [{ name: 'keeper', source: './plugins/keeper' }],
  };

  for (const plugin of ['gone', 'keeper']) {
    await quietly(() =>
      installPlugin({
        brand,
        plugin,
        targets: TARGETS,
        deps: deps({ repo, plugin, srcDir: pluginSource(plugin) }),
        pathOpts: m.pathOpts,
      }),
    );
  }

  const after = {
    ...deps({ repo, srcDir: pluginSource('keeper') }),
    fetchImpl: stubFetch({
      [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: { body: listed },
    }),
  };
  const { result } = await capture(() => updateAll({ brand, deps: after, pathOpts: m.pathOpts }));

  assert.deepEqual(result.updated, ['keeper']);
  assert.deepEqual(result.skipped, ['gone']);
  assert.deepEqual(result.failed, []);
});

test('an unreachable registry is never reported as unsupported', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const brand = brandFor(repo);

  await quietly(() =>
    installPlugin({
      brand,
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir: pluginSource() }),
      pathOpts: m.pathOpts,
    }),
  );

  const offline = {
    env: {},
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
    },
  };
  const { result, out } = await capture(() =>
    updateAll({ brand, deps: offline, pathOpts: m.pathOpts }),
  );

  assert.deepEqual(result.skipped, [], 'a network failure is not evidence a plugin was dropped');
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /Could not reach/);
  assert.doesNotMatch(out, /no longer supported/);
});

test('a de-listed plugin can still be uninstalled', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const brand = brandFor(repo);

  await quietly(() =>
    installPlugin({
      brand,
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: deps({ repo, srcDir: pluginSource() }),
      pathOpts: m.pathOpts,
    }),
  );

  // The escape hatch must not need the registry that dropped the plugin.
  const offline = {
    env: {},
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
    },
  };
  await quietly(() =>
    uninstallPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: offline, pathOpts: m.pathOpts }),
  );

  assert.equal(manifest.list(paths.manifestPath(m.pathOpts)).length, 0);
  assert.ok(
    !fs.existsSync(path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk')),
    'the files are gone once the user asks for that',
  );
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
