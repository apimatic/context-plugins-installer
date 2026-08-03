'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { installPlugin, uninstallPlugin, listPlugins, chooseHarnesses } = require('../src/install');
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
  const { chosen, source } = await chooseHarnesses(['cursor', 'vscode'], {
    explicit: true,
    confirm,
  });
  assert.deepEqual(chosen, ['cursor', 'vscode']);
  assert.equal(source, 'explicit_targets');
  assert.deepEqual(confirm.asked, []);
});

test('--yes skips the prompt', async () => {
  const confirm = scriptedConfirm([]);
  const { chosen, source } = await chooseHarnesses(['cursor', 'vscode'], {
    assumeYes: true,
    confirm,
  });
  assert.deepEqual(chosen, ['cursor', 'vscode']);
  assert.equal(source, 'assume_yes');
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

// ---- telemetry -----------------------------------------------------------

/** Collects events in place of sending them. */
function recorder() {
  const events = [];
  return {
    events,
    only(name) {
      return events.filter((e) => e.event === name);
    },
    track(event, props) {
      events.push({ event, props });
    },
    async flush() {},
  };
}

test('a declined harness is reported as declined, not merely absent', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null, // no --targets => ask
      deps: { ...deps({ repo, srcDir }), confirm: scriptedConfirm([false, true]), telemetry },
      pathOpts: m.pathOpts,
    }),
  );

  assert.equal(telemetry.events.length, 1);
  const { event, props } = telemetry.events[0];
  assert.equal(event, 'Install');
  assert.equal(props.plugin, 'my-sdk');
  assert.equal(props.trigger, 'install');
  assert.equal(props.outcome, 'success', 'everything the user accepted was installed');
  assert.equal(props.error_code, null);
  assert.equal(props.prompt_source, 'interactive', 'a real answer, not an auto-accept');
  assert.deepEqual(props.detected_harnesses, ['cursor', 'vscode']);
  assert.deepEqual(props.declined_harnesses, ['cursor']);
  assert.deepEqual(props.accepted_harnesses, ['vscode']);
  assert.deepEqual(props.installed_harnesses, ['vscode']);
  assert.equal(props.custom_marketplace, false);
  assert.equal(typeof props.duration_ms, 'number');
});

test('declining every harness is its own outcome', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      deps: {
        ...deps({ repo, srcDir: pluginSource() }),
        confirm: scriptedConfirm([false, false]),
        telemetry,
      },
      pathOpts: m.pathOpts,
    }),
  );

  const { props } = telemetry.events[0];
  assert.equal(props.outcome, 'no_harness_selected');
  assert.deepEqual(props.declined_harnesses, ['cursor', 'vscode']);
  assert.equal(props.fetch_via, 'none', 'nothing was fetched');
  assert.equal(props.fetch_duration_ms, null);
});

test('an auto-accepted run is not counted as a user decision', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS, // explicit --targets
      deps: { ...deps({ repo, srcDir: pluginSource() }), telemetry },
      pathOpts: m.pathOpts,
    }),
  );

  const { props } = telemetry.events[0];
  assert.equal(props.prompt_source, 'explicit_targets');
  assert.deepEqual(props.declined_harnesses, [], 'nobody declined anything');
});

test('a custom marketplace is reported as a flag, never by name', async () => {
  const m = machine();
  const repo = 'acme/private-marketplace';
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: { ...deps({ repo, marketplace: 'acme', srcDir: pluginSource() }), telemetry },
      pathOpts: m.pathOpts,
    }),
  );

  const { props } = telemetry.events[0];
  assert.equal(props.custom_marketplace, true);
  const sent = JSON.stringify(props);
  assert.ok(!sent.includes('acme'), `marketplace leaked into the event: ${sent}`);
  assert.ok(!sent.includes(m.root), `a filesystem path leaked into the event: ${sent}`);
});

test('a failed install reports why, by code', async () => {
  const m = machine();
  const srcDir = pluginSource();
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({
      brand: brandFor('context-plugins/plugin-marketplace'),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: { ...deps({ repo: 'context-plugins/plugin-marketplace', srcDir }), telemetry },
      pathOpts: m.pathOpts,
    }),
  );

  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brandFor('acme/plugin-marketplace'),
        plugin: 'my-sdk',
        targets: TARGETS,
        deps: {
          ...deps({ repo: 'acme/plugin-marketplace', marketplace: 'acme', srcDir }),
          telemetry,
        },
        pathOpts: m.pathOpts,
      }),
    ),
  );

  const last = telemetry.events[telemetry.events.length - 1].props;
  assert.equal(last.outcome, 'error');
  assert.equal(last.error_code, 'force_needed');
  assert.equal(typeof last.duration_ms, 'number');
});

test('update reports itself as an update, not a fresh install', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const d = deps({ repo, srcDir: pluginSource() });
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: { ...d, telemetry },
      pathOpts: m.pathOpts,
    }),
  );

  const { updateAll } = require('../src/install');
  await quietly(() =>
    updateAll({ brand: brandFor(repo), deps: { ...d, telemetry }, pathOpts: m.pathOpts }),
  );

  assert.deepEqual(
    telemetry.only('Install').map((e) => e.props.trigger),
    ['install', 'update'],
  );
});

test('uninstall reports how long the plugin lasted', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const brand = brandFor(repo);
  const d = deps({ repo, srcDir: pluginSource() });
  const telemetry = recorder();

  await quietly(() =>
    installPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: { ...d, telemetry }, pathOpts: m.pathOpts }),
  );
  await quietly(() =>
    uninstallPlugin({ brand, plugin: 'my-sdk', targets: TARGETS, deps: { ...d, telemetry }, pathOpts: m.pathOpts }),
  );

  const [{ props }] = telemetry.only('Uninstall');
  assert.equal(props.plugin, 'my-sdk');
  assert.deepEqual(props.removed_harnesses, ['cursor', 'vscode']);
  assert.equal(typeof props.time_since_install_ms, 'number');
  assert.ok(props.time_since_install_ms >= 0);
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
