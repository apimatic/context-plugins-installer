import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { localMarketplace } from '../src/infrastructure/local-marketplace.js';
import { LOCAL_MARKETPLACE } from '../src/types/brand.js';
import { readRaw } from '../src/infrastructure/manifest-store.js';
import * as paths from '../src/infrastructure/paths.js';
import {
  brandFor,
  claudeMachine,
  flat,
  installPlugin,
  machine,
  quietly,
  registryOnly,
  sinkInto,
  uninstallPlugin,
  updateAll,
  wiring as marketWiring,
  type Machine,
  type Tracked,
} from './install-fixture.js';
import { cleanupAll, silenceConsole, stubFetch, tmpDir } from './helpers.js';

test.after(cleanupAll);

// Installing a plugin from a directory, end to end. The `registryOnly` wiring
// carries no stub registry: a local install that reaches for one fails loudly.

const REPO = 'acme/plugin-marketplace';
const brand = () => brandFor(REPO);
const wiring = () => registryOnly(stubFetch({}));

function pluginDir(name = 'my-sdk', over: Record<string, unknown> = {}): string {
  const dir = path.join(tmpDir('cp-dev-'), name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'thing'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: 'A plugin from a folder', version: '0.1.0', ...over }),
  );
  fs.writeFileSync(path.join(dir, 'skills', 'thing', 'SKILL.md'), '# thing');
  return dir;
}

const rowsOf = (m: Machine): Record<string, unknown>[] =>
  readRaw(paths.manifestPath(m.pathOpts)).plugins as Record<string, unknown>[];

test('a directory is installed into the file-copying editors, with no registry read', async () => {
  const m = machine();
  const dir = pluginDir();

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor', 'vscode'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );

  assert.deepEqual(report.targets, ['cursor', 'vscode']);
  assert.equal(report.plugin?.toString(), 'my-sdk');
  assert.equal(report.marketplace, LOCAL_MARKETPLACE);
  assert.equal(report.ref, null, 'a directory has no ref to report');

  for (const dest of [
    paths.cursorLocalDir(m.pathOpts).join('my-sdk'),
    paths.vscodeStoreDir(m.pathOpts).join('my-sdk'),
  ]) {
    assert.ok(
      fs.existsSync(path.join(dest.toString(), 'skills', 'thing', 'SKILL.md')),
      `expected the plugin's files under ${dest}`,
    );
  }
});

test('the id comes from the manifest, whatever the folder is called', async () => {
  const m = machine();
  // The space in the folder name is load-bearing - this suite runs on Windows too.
  const dir = pluginDir('folder name', { name: 'declared-name' });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );

  assert.equal(report.plugin?.toString(), 'declared-name');
  assert.ok(fs.existsSync(paths.cursorLocalDir(m.pathOpts).join('declared-name').toString()));
});

test('the record keys on the directory, so the same id from a marketplace is a second row', async () => {
  const m = machine();
  const dir = pluginDir();

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );

  const rows = rowsOf(m);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.plugin, 'my-sdk');
  assert.equal(rows[0]?.repo, `local:${dir}`, 'the key is the resolved directory');
  assert.equal(rows[0]?.marketplace, LOCAL_MARKETPLACE);
});

test('a relative path resolves against the cwd the run was given', async () => {
  const m = machine();
  const dir = pluginDir();
  const parent = path.dirname(dir);

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: `./${path.basename(dir)}`,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: { ...m.pathOpts, cwd: parent },
      wiring: wiring(),
    }),
  );

  assert.equal(report.plugin?.toString(), 'my-sdk');
  assert.equal(rowsOf(m)[0]?.repo, `local:${dir}`);
});

test('nothing is staged for Claude Code when Claude Code is not a target', async () => {
  const m = machine();
  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor', 'vscode'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );
  assert.equal(fs.existsSync(localMarketplace(m.pathOpts).dir.toString()), false);
});

test('installing into Claude Code stages the plugin and addresses the generated marketplace', async () => {
  const m = claudeMachine();
  const { calls } = m;

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['claude'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );

  assert.deepEqual(report.targets, ['claude']);

  const root = localMarketplace(m.pathOpts).dir;
  const registry = path.join(root.toString(), '.claude-plugin', 'marketplace.json');
  assert.ok(fs.existsSync(path.join(root.toString(), 'plugins', 'my-sdk', 'skills', 'thing')));
  const declared = JSON.parse(fs.readFileSync(registry, 'utf8')) as {
    name: string;
    plugins: { name: string; source: string }[];
  };
  assert.equal(declared.name, LOCAL_MARKETPLACE);
  assert.deepEqual(declared.plugins, [
    { name: 'my-sdk', source: './plugins/my-sdk', description: 'A plugin from a folder' },
  ]);

  // Claude caches by the version the manifest declares, so an edited plugin whose
  // version did not move needs the removal to copy anything.
  assert.ok(
    calls.some((c) => c === `plugin marketplace add ${root}`),
    `expected the directory to be added, got: ${calls.join(' | ')}`,
  );
  const uninstall = calls.indexOf(`plugin uninstall my-sdk@${LOCAL_MARKETPLACE} --scope user`);
  const install = calls.indexOf(`plugin install my-sdk@${LOCAL_MARKETPLACE} --scope user`);
  assert.ok(uninstall >= 0, `expected a pre-install removal, got: ${calls.join(' | ')}`);
  assert.ok(install > uninstall, 'the removal has to come first to be worth anything');
});

test('a directory that is not a plugin fails before anything is copied', async () => {
  const m = machine();
  const empty = tmpDir('cp-empty-');

  await assert.rejects(
    () =>
      quietly(() =>
        installPlugin({
          brand: brand(),
          plugin: empty,
          targets: ['cursor'],
          assumeYes: true,
          pathOpts: m.pathOpts,
          wiring: wiring(),
        }),
      ),
    /does not look like a plugin/,
  );
  assert.deepEqual(rowsOf(m), [], 'nothing recorded');
  assert.equal(fs.existsSync(paths.cursorLocalDir(m.pathOpts).toString()), false);
});

test('the source is named, and the warning about what a plugin can run is said', async () => {
  const m = machine();
  const dir = pluginDir();
  const con = silenceConsole();
  try {
    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
  } finally {
    con.restore();
  }
  const said = flat(con);
  assert.match(said, /not from Claude Code's marketplace/);
  assert.match(said, /can run commands/);
  assert.match(said, /Installing 'my-sdk' from/);
});

test('declining the source installs nothing and is not a failure', async () => {
  const m = machine();
  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor'],
      ask: () => false,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );
  assert.deepEqual(report.targets, []);
  assert.deepEqual(rowsOf(m), []);
});

test('a cancel at the source question stops the run rather than installing', async () => {
  const m = machine();
  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor'],
      ask: () => 'cancelled',
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );
  assert.deepEqual(report.targets, []);
  assert.deepEqual(rowsOf(m), []);
});

test('telemetry reports the kind and withholds the folders plugin name', async () => {
  const m = machine();
  const events: Tracked[] = [];

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
      sink: sinkInto(events),
    }),
  );

  const installed = events.filter((e) => e.name === 'Context Plugin Installed');
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.properties.source_kind, 'local');
  assert.equal(installed[0]?.properties.plugin, null, 'a local plugin id stays on the machine');
  assert.equal(installed[0]?.properties.marketplace, 'custom');
  for (const event of events) {
    for (const value of Object.values(event.properties)) {
      assert.ok(
        typeof value !== 'string' || !value.includes(path.sep + 'cp-dev-'),
        `a path reached telemetry: ${String(value)}`,
      );
    }
  }
});

test('a marketplace install still reports its id and its kind', async () => {
  const m = machine();
  const events: Tracked[] = [];
  const srcDir = pluginDir('market-sdk');

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'market-sdk',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: marketWiring({ repo: REPO, plugin: 'market-sdk', srcDir }),
      sink: sinkInto(events),
    }),
  );

  const installed = events.filter((e) => e.name === 'Context Plugin Installed');
  assert.equal(installed[0]?.properties.plugin, 'market-sdk');
  assert.equal(installed[0]?.properties.source_kind, 'marketplace');
});

test('uninstalling by its id finds the row a directory install keyed by path', () => {
  return quietly(async () => {
    const m = machine();
    const dir = pluginDir();
    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor', 'vscode'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    const report = await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['cursor', 'vscode'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(report.targets, ['cursor', 'vscode']);
    assert.deepEqual(rowsOf(m), [], 'the row goes with the files');
    assert.equal(fs.existsSync(paths.cursorLocalDir(m.pathOpts).join('my-sdk').toString()), false);
    assert.equal(fs.existsSync(paths.vscodeStoreDir(m.pathOpts).join('my-sdk').toString()), false);
  });
});

test('the last path plugin out takes the generated marketplace with it', () => {
  return quietly(async () => {
    const m = claudeMachine();
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['claude'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    assert.ok(fs.existsSync(localMarketplace(m.pathOpts).dir.toString()), 'staged first');

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(rowsOf(m), []);
    assert.equal(
      fs.existsSync(localMarketplace(m.pathOpts).dir.toString()),
      false,
      'an empty generated marketplace is a row offering nothing',
    );
  });
});

test('one path plugin leaving does not unstage another', () => {
  return quietly(async () => {
    const m = claudeMachine();
    for (const name of ['first', 'second']) {
      await installPlugin({
        brand: brand(),
        plugin: pluginDir(name),
        targets: ['claude'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: wiring(),
      });
    }

    await uninstallPlugin({
      brand: brand(),
      plugin: 'first',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    const root = localMarketplace(m.pathOpts).dir.toString();
    assert.equal(fs.existsSync(path.join(root, 'plugins', 'first')), false);
    assert.ok(fs.existsSync(path.join(root, 'plugins', 'second')), 'the other one stays');
    assert.deepEqual(
      rowsOf(m).map((r) => r.plugin),
      ['second'],
    );
  });
});

test('update re-syncs a path row from the folder it was installed from', () => {
  return quietly(async () => {
    const m = machine();
    const dir = pluginDir();
    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    fs.writeFileSync(path.join(dir, 'skills', 'thing', 'NEW.md'), '# added since');
    fs.rmSync(path.join(dir, 'skills', 'thing', 'SKILL.md'));

    const report = await updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring: wiring() });

    assert.deepEqual(
      report.rows.map((r) => r.outcome),
      ['updated'],
    );
    assert.deepEqual(report.updated, ['my-sdk']);
    const installed = path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk');
    assert.ok(fs.existsSync(path.join(installed, 'skills', 'thing', 'NEW.md')), 'the new file');
    assert.ok(!fs.existsSync(path.join(installed, 'skills', 'thing', 'SKILL.md')));
  });
});

test('a path row whose folder is gone is reported, and never fails the run', () => {
  return quietly(async () => {
    const m = machine();
    const dir = pluginDir();
    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    fs.rmSync(dir, { recursive: true, force: true });

    const con = silenceConsole();
    let report;
    try {
      report = await updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring: wiring() });
    } finally {
      con.restore();
    }

    assert.deepEqual(report.rows, [
      {
        outcome: 'unavailable',
        plugin: 'my-sdk',
        reason: 'the folder it was installed from is gone',
      },
    ]);
    assert.deepEqual(report.failed, [], 'exit 0');
    assert.match(flat(con), /the folder it was installed from is gone - install it again/);
    // The row stays: the editor's copy of the plugin is still there.
    assert.equal(rowsOf(m).length, 1);
  });
});

test('a path row reports the folders plugin name to nobody when it re-syncs', () => {
  return quietly(async () => {
    const m = machine();
    const events: Tracked[] = [];
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    await updateAll({
      brand: brand(),
      pathOpts: m.pathOpts,
      wiring: wiring(),
      sink: sinkInto(events),
    });

    const installed = events.filter((e) => e.name === 'Context Plugin Installed');
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.properties.source_kind, 'local');
    assert.equal(installed[0]?.properties.plugin, null, 'the same rule as the install');
    assert.equal(installed[0]?.properties.marketplace, 'custom');
  });
});

test('a row whose folder is gone sends nothing at all', () => {
  return quietly(async () => {
    const m = machine();
    const events: Tracked[] = [];
    const dir = pluginDir();
    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    fs.rmSync(dir, { recursive: true, force: true });

    await updateAll({
      brand: brand(),
      pathOpts: m.pathOpts,
      wiring: wiring(),
      sink: sinkInto(events),
    });

    assert.deepEqual(events, []);
  });
});

test('the last path plugin out deregisters the generated marketplace', () => {
  return quietly(async () => {
    const m = claudeMachine();
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['claude'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    m.calls.length = 0;

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.ok(
      m.calls.includes(`plugin marketplace remove ${LOCAL_MARKETPLACE}`),
      `expected the registration to be dropped, got: ${m.calls.join(' | ')}`,
    );
  });
});

test('a path plugin that is not the last one leaves the marketplace registered', () => {
  return quietly(async () => {
    const m = claudeMachine();
    for (const name of ['first', 'second']) {
      await installPlugin({
        brand: brand(),
        plugin: pluginDir(name),
        targets: ['claude'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: wiring(),
      });
    }
    m.calls.length = 0;

    await uninstallPlugin({
      brand: brand(),
      plugin: 'first',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.ok(
      !m.calls.some((c) => c.startsWith('plugin marketplace remove')),
      'the other plugin still needs it',
    );
  });
});

test('uninstall telemetry withholds the folders plugin name too', () => {
  return quietly(async () => {
    const m = machine();
    const events: Tracked[] = [];
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['cursor'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
      sink: sinkInto(events),
    });

    const removed = events.filter((e) => e.name === 'Context Plugin Uninstalled');
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.properties.plugin, null);
    assert.equal(removed[0]?.properties.source_kind, 'local');
    assert.equal(removed[0]?.properties.marketplace, 'custom');
  });
});

test('a path row the read view hides is still reachable by uninstall', () => {
  // A row naming only 'zed' is dropped from the sanitized read view.
  return quietly(async () => {
    const m = machine();
    const file = paths.manifestPath(m.pathOpts).toString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            plugin: 'my-sdk',
            repo: 'local:/somewhere/my-sdk',
            marketplace: LOCAL_MARKETPLACE,
            targets: ['zed'],
          },
        ],
      }),
    );

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['cursor'],
      force: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(rowsOf(m), [], 'the stranded row is clearable');
  });
});

test('the repository a developer works in is not installed along with the plugin', () => {
  return quietly(async () => {
    const m = machine();
    const dir = pluginDir();
    fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]');

    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    const installed = path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', 'my-sdk');
    assert.ok(fs.existsSync(path.join(installed, 'skills', 'thing', 'SKILL.md')), 'the plugin');
    assert.ok(!fs.existsSync(path.join(installed, '.git')), 'and not the repository');
  });
});

test('a hand-edited row this build cannot address is reported, not fatal', () => {
  return quietly(async () => {
    const m = machine();
    const file = paths.manifestPath(m.pathOpts).toString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            plugin: 'Not An Id',
            repo: `local:${pluginDir()}`,
            marketplace: LOCAL_MARKETPLACE,
            targets: ['cursor'],
          },
        ],
      }),
    );

    const report = await updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring: wiring() });
    assert.deepEqual(report.rows, [
      {
        outcome: 'unavailable',
        plugin: 'Not An Id',
        reason: 'the name on its record is not one this build can read',
      },
    ]);
    assert.deepEqual(report.failed, [], 'exit 0');
  });
});

test('a plugin that renames itself is not left silently installed twice', () => {
  return quietly(async () => {
    const m = machine();
    const dir = pluginDir();
    await installPlugin({
      brand: brand(),
      plugin: dir,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'renamed-sdk', description: 'A plugin from a folder' }),
    );

    const con = silenceConsole();
    try {
      await updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring: wiring() });
    } finally {
      con.restore();
    }

    assert.match(flat(con), /now calls itself 'renamed-sdk'/);
    assert.match(flat(con), /uninstall 'my-sdk'/);
    const local = path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local');
    assert.deepEqual(fs.readdirSync(local).sort(), ['my-sdk', 'renamed-sdk']);
    assert.equal(rowsOf(m).length, 2);
  });
});
