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
  withCodex,
  withHarness,
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

test('a --ref alongside a directory is said out loud rather than dropped', async () => {
  const m = machine();
  const dir = pluginDir();
  const con = silenceConsole();
  try {
    await installPlugin({
      brand: brand(),
      plugin: dir,
      ref: 'v2',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
  } finally {
    con.restore();
  }
  assert.match(flat(con), /A directory has no ref - --ref v2 was not used/);
});

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
  assert.ok(
    said.indexOf('can run commands') < said.indexOf("Installing 'my-sdk' from"),
    'the question about the source is asked before the banner that names the plugin',
  );
});

test('the question comes before the source is read, so a declined one is never opened', async () => {
  const m = machine();
  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: path.join(tmpDir('cp-gone-'), 'not-here'),
      targets: ['cursor'],
      ask: () => false,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );
  // Reading it first would fail the run on a directory the user declined to
  // trust, which is a message about the wrong thing entirely.
  assert.deepEqual(report.targets, []);
  assert.deepEqual(rowsOf(m), []);
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

// Codex installs from a marketplace too, and reads the same generated one - so
// a path plugin is staged for it exactly as for Claude Code.
test('installing into Codex stages the plugin and addresses the generated marketplace', async () => {
  const m = withCodex(machine());

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['codex'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    }),
  );

  assert.deepEqual(report.targets, ['codex']);
  const root = localMarketplace(m.pathOpts).dir.toString();
  assert.ok(fs.existsSync(path.join(root, 'plugins', 'my-sdk', 'skills', 'thing')));
  assert.ok(m.codexCalls.includes(`plugin marketplace add ${root}`), m.codexCalls.join(' | '));
  assert.ok(m.codexCalls.includes(`plugin add my-sdk@${LOCAL_MARKETPLACE}`));
});

/** A path plugin installed into both CLI-driven editors, on one machine. */
async function inBoth(answer?: (line: string) => { code?: number; stderr?: string } | undefined) {
  const m = withCodex(claudeMachine(), answer);
  await installPlugin({
    brand: brand(),
    plugin: pluginDir(),
    targets: ['claude', 'codex'],
    assumeYes: true,
    pathOpts: m.pathOpts,
    wiring: wiring(),
  });
  const staged = (): boolean =>
    fs.existsSync(path.join(localMarketplace(m.pathOpts).dir.toString(), 'plugins', 'my-sdk'));
  assert.ok(staged(), 'staged once, for both');
  return { m, staged };
}

// The marketplace is shared, so the first editor out must not take it from the
// other: Codex left registered to a directory that has gone cannot list any
// plugin at all, and one whose plugin vanished from it no longer shows it.
test('a path plugin Codex still holds stays staged when Claude Code lets it go', () => {
  return quietly(async () => {
    const { m, staged } = await inBoth();

    const report = await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(report.targets, ['claude']);
    assert.ok(staged(), 'Codex still reads it');
    assert.deepEqual(rowsOf(m)[0]?.targets, ['codex']);
    assert.ok(!m.calls.some((c) => c.startsWith('plugin marketplace remove')));
    assert.ok(!m.codexCalls.some((c) => c.startsWith('plugin marketplace remove')));
  });
});

test('the last editor out unstages it, and every CLI forgets the generated marketplace', () => {
  return quietly(async () => {
    // Once the directory is gone a real Codex cannot list marketplaces at all,
    // which is exactly when the registration has to go.
    let gone = false;
    const { m, staged } = await inBoth((line) =>
      gone && line.startsWith('plugin marketplace list')
        ? { code: 1, stderr: 'failed to load marketplace(s)' }
        : undefined,
    );
    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    gone = true;

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['codex'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.equal(staged(), false);
    assert.equal(fs.existsSync(localMarketplace(m.pathOpts).dir.toString()), false);
    assert.deepEqual(rowsOf(m), []);
    assert.ok(m.codexCalls.includes(`plugin marketplace remove ${LOCAL_MARKETPLACE}`));
    assert.ok(
      m.calls.includes(`plugin marketplace remove ${LOCAL_MARKETPLACE}`),
      'Claude Code was not asked this run, and still points at the same directory',
    );
  });
});

// Codex comes last in the loop and can fail after the editors before it have
// their copy. Unrecorded, those copies are ones nothing can update or remove.
test('editors installed before a failing one are still recorded', () => {
  return quietly(async () => {
    const m = withCodex(machine(), (line) =>
      line.startsWith('plugin add') ? { code: 1, stderr: 'Error: disk full' } : undefined,
    );

    await assert.rejects(
      installPlugin({
        brand: brand(),
        plugin: pluginDir(),
        targets: ['cursor', 'vscode', 'codex'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: wiring(),
      }),
      /codex plugin add my-sdk@context-plugins-local failed/,
    );

    assert.deepEqual(rowsOf(m)[0]?.targets, ['cursor', 'vscode']);
    assert.ok(fs.existsSync(paths.cursorLocalDir(m.pathOpts).join('my-sdk').toString()));
  });
});

test('a Codex too old for plugins is skipped, and the others install as usual', () => {
  return quietly(async () => {
    const tooOld = { code: 2, stderr: "error: unexpected argument 'marketplace' found" };
    const m = withCodex(machine(), (line) =>
      line.startsWith('plugin marketplace') ? tooOld : undefined,
    );

    const report = await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['cursor', 'codex'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(report.targets, ['cursor']);
    assert.deepEqual(rowsOf(m)[0]?.targets, ['cursor']);
    assert.ok(!m.codexCalls.some((c) => c.startsWith('plugin add')));
  });
});

test('a Codex removal that fails keeps the plugin staged for the retry', () => {
  return quietly(async () => {
    const { m, staged } = await inBoth((line) =>
      line.startsWith('plugin remove') ? { code: 1, stderr: 'EPERM' } : undefined,
    );

    await assert.rejects(
      uninstallPlugin({
        brand: brand(),
        plugin: 'my-sdk',
        pathOpts: m.pathOpts,
        wiring: wiring(),
      }),
      /Could not uninstall 'my-sdk' from Codex/,
    );

    assert.ok(staged(), 'Codex may still read it');
    assert.deepEqual(rowsOf(m)[0]?.targets, ['codex']);
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

// A re-install that fails partway must not shrink the row: the editor that
// failed still holds the copy an earlier run gave it, and a row it has left
// is one nothing can ever update or uninstall.
test('a failing re-install keeps the failed editor on the row', () => {
  return quietly(async () => {
    let fail = false;
    const m = withCodex(machine(), (line) =>
      fail && line.startsWith('plugin add') ? { code: 1, stderr: 'Error: disk full' } : undefined,
    );
    const dir = pluginDir();
    const install = () =>
      installPlugin({
        brand: brand(),
        plugin: dir,
        targets: ['cursor', 'codex'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: wiring(),
      });
    await install();
    assert.deepEqual(rowsOf(m)[0]?.targets, ['cursor', 'codex']);

    fail = true;
    await assert.rejects(install(), /codex plugin add/);

    assert.deepEqual(
      rowsOf(m)[0]?.targets,
      ['cursor', 'codex'],
      'the copy Codex still loads stays recorded',
    );
  });
});

// A harness that throws is a bug, but the editors already installed still get
// their row before the throw goes up - same reason as the failure arm above.
test('editors installed before a throwing harness are still recorded', () => {
  return quietly(async () => {
    const m = machine();
    await withHarness(
      'codex',
      {
        detect: () => true,
        install: async () => {
          throw new Error('boom');
        },
      },
      async () => {
        await assert.rejects(
          installPlugin({
            brand: brand(),
            plugin: pluginDir(),
            targets: ['cursor', 'codex'],
            assumeYes: true,
            pathOpts: m.pathOpts,
            wiring: wiring(),
          }),
          /boom/,
        );
      },
    );
    assert.deepEqual(rowsOf(m)[0]?.targets, ['cursor'], 'the copy is not left unrecorded');
  });
});

// `--force` clears the row over a CLI that could not look, but the CLI is
// still registered to the marketplace - deleting the directory would leave it
// pointing at nothing, which for Codex breaks every listing it has.
test('--force over an unreachable Codex leaves the shared marketplace standing', () => {
  return quietly(async () => {
    const base = claudeMachine();
    const m = withCodex(base);
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['claude', 'codex'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    const staged = path.join(localMarketplace(m.pathOpts).dir.toString(), 'plugins', 'my-sdk');
    assert.ok(fs.existsSync(staged), 'staged for both');

    // The same machine without `codex` on PATH: the CLI is unreachable, its
    // registration is not.
    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['claude', 'codex'],
      force: true,
      pathOpts: base.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(rowsOf(m), [], '--force still clears the record');
    assert.ok(fs.existsSync(staged), 'the directory Codex is registered to stays');
    assert.ok(!base.calls.some((c) => c.startsWith('plugin marketplace remove')));
  });
});

// A row that survives in a shape this build cannot read is exactly the row
// that says an editor it cannot see may still hold the plugin.
test('a foreign leftover row keeps the shared marketplace staged', () => {
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
    const file = paths.manifestPath(m.pathOpts).toString();
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      plugins: Record<string, unknown>[];
    };
    doc.plugins[0].targets = ['claude', 'zed'];
    fs.writeFileSync(file, JSON.stringify(doc));

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['claude'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(rowsOf(m)[0]?.targets, ['zed'], 'the row survives for whoever wrote it');
    assert.ok(
      fs.existsSync(localMarketplace(m.pathOpts).dir.toString()),
      "whatever 'zed' is may still read the marketplace",
    );
    assert.ok(!m.calls.some((c) => c.startsWith('plugin marketplace remove')));
  });
});

// The generated marketplace's name is the same constant for every state dir on
// the machine, so a registration by that name is not proof it is this one's.
test('a same-named marketplace from another directory is not ours to remove', () => {
  return quietly(async () => {
    const m = claudeMachine();
    const elsewhere = tmpDir('cp-other-state-');
    m.marketplaces.push({
      name: LOCAL_MARKETPLACE,
      source: 'directory',
      path: elsewhere,
      installLocation: elsewhere,
    });

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
    });

    assert.ok(!m.calls.some((c) => c.startsWith('plugin marketplace remove')));
    assert.equal(m.marketplaces.length, 1, "the other directory's registration survives");
  });
});

// Codex keys a marketplace by the name it had when added, which can drift from
// the name the registry carries today - the registration has to be removed by
// the name Codex actually holds, and while the directory still exists to list.
test('a Codex registration under a drifted name is still forgotten', () => {
  return quietly(async () => {
    let drifted = '';
    const m = withCodex(machine(), (line) =>
      drifted && line.startsWith('plugin marketplace list')
        ? { code: 0, stdout: drifted }
        : undefined,
    );
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['codex'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    const root = localMarketplace(m.pathOpts).dir.toString();
    drifted = JSON.stringify({ marketplaces: [{ name: 'old-name', root }] });

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['codex'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.ok(
      m.codexCalls.includes('plugin marketplace remove old-name'),
      `expected the drifted name to be removed, got: ${m.codexCalls.join(' | ')}`,
    );
    assert.equal(fs.existsSync(root), false, 'and the directory goes after it');
  });
});

// With both of Codex's listings broken, whether it still holds the plugin is
// an open question - and an open question must keep the record, never read as
// the positive finding `absent` is.
test('a Codex whose listings cannot answer keeps the record and the staging', () => {
  return quietly(async () => {
    let broken = false;
    const m = withCodex(machine(), (line) =>
      broken && (line.startsWith('plugin marketplace list') || line.startsWith('plugin list'))
        ? { code: 1, stderr: 'failed to load marketplace(s)' }
        : undefined,
    );
    await installPlugin({
      brand: brand(),
      plugin: pluginDir(),
      targets: ['codex'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });
    broken = true;

    await uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['codex'],
      pathOpts: m.pathOpts,
      wiring: wiring(),
    });

    assert.deepEqual(rowsOf(m)[0]?.targets, ['codex'], 'nothing established absence');
    assert.ok(fs.existsSync(localMarketplace(m.pathOpts).dir.toString()), 'staging stays');
  });
});
