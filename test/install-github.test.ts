import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { registryClient, rawUrl } from '../src/infrastructure/github-registry-client.js';
import { localMarketplace } from '../src/infrastructure/local-marketplace.js';
import { readRaw } from '../src/infrastructure/manifest-store.js';
import * as paths from '../src/infrastructure/paths.js';
import { LOCAL_MARKETPLACE } from '../src/types/brand.js';
import { DirectoryPath } from '../src/types/file/paths.js';
import type { SourceFetcher } from '../src/types/ports.js';
import { ok } from '../src/types/result.js';
import {
  brandFor,
  claudeMachine,
  flat,
  installPlugin,
  machine,
  pluginSource,
  quietly,
  sinkInto,
  uninstallPlugin,
  updateAll,
  type Machine,
  type Tracked,
  type Wiring,
} from './install-fixture.js';
import { cleanupAll, portsFor, silenceConsole, stubFetch, type StubRoute } from './helpers.js';

test.after(cleanupAll);

// Installing a plugin from a repository that is itself a plugin - the whole of it
// or a folder inside it - with the real registry client over a stub fetch.

const MARKET = 'acme/plugin-marketplace';
const brand = () => brandFor(MARKET);

const MANIFEST = '.claude-plugin/plugin.json';

interface Fetched {
  repo: string;
  ref: string;
  sourcePath: string | null;
}

interface GithubSpec {
  repo: string;
  ref?: string;
  path?: string | null;
  manifest?: Record<string, unknown> | null;
  routes?: Record<string, StubRoute>;
}

function githubWiring(spec: GithubSpec): {
  wiring: Wiring;
  fetched: Fetched[];
  asked: string[];
} {
  const { repo, ref = 'main', path: under = null, manifest = { name: 'my-sdk' } } = spec;
  const at = under === null ? MANIFEST : `${under}/${MANIFEST}`;
  const fetchImpl = stubFetch({
    ...(manifest ? { [rawUrl(repo, ref, at)]: { body: manifest } } : {}),
    ...(spec.routes ?? {}),
  });
  const ports = portsFor(fetchImpl);
  const srcDir = pluginSource('my-sdk');
  const fetched: Fetched[] = [];
  const fetcher: SourceFetcher = {
    openRepo: async ({ repo: from, ref: version }) => ({
      via: 'api',
      cleanup: () => {},
      checkout: async (sourcePath) => {
        fetched.push({ repo: from, ref: version, sourcePath });
        return ok(new DirectoryPath(srcDir));
      },
    }),
  };
  return {
    wiring: { ports, registry: registryClient(ports), fetcher },
    fetched,
    asked: fetchImpl.calls,
  };
}

const rowsOf = (m: Machine): Record<string, unknown>[] =>
  readRaw(paths.manifestPath(m.pathOpts)).plugins as Record<string, unknown>[];

const cursorDir = (m: Machine, plugin: string): string =>
  path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', plugin);

test('a repository that is itself a plugin is installed from its own root', async () => {
  const m = machine();
  const { wiring, fetched } = githubWiring({ repo: 'acme/thing' });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor', 'vscode'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  assert.deepEqual(report.targets, ['cursor', 'vscode']);
  assert.equal(report.ref, 'main');
  assert.deepEqual(fetched, [{ repo: 'acme/thing', ref: 'main', sourcePath: null }]);
  assert.ok(fs.existsSync(path.join(cursorDir(m, 'my-sdk'), 'plugin.json')));

  assert.equal(rowsOf(m).length, 1);
  assert.equal(rowsOf(m)[0]?.repo, 'github:acme/thing');
  assert.equal(rowsOf(m)[0]?.plugin, 'my-sdk');
});

test('the id comes from the manifest, never from the repository name', async () => {
  const m = machine();
  const { wiring } = githubWiring({ repo: 'acme/thing', manifest: { name: 'actually-called' } });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  assert.equal(rowsOf(m)[0]?.plugin, 'actually-called');
  assert.ok(fs.existsSync(cursorDir(m, 'actually-called')));
});

test('a folder inside a repository is fetched from that folder, and keyed by it', async () => {
  const m = machine();
  const { wiring, fetched } = githubWiring({ repo: 'acme/mono', path: 'tools/foo' });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/mono/tools/foo',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  assert.deepEqual(fetched, [{ repo: 'acme/mono', ref: 'main', sourcePath: 'tools/foo' }]);
  assert.equal(rowsOf(m)[0]?.repo, 'github:acme/mono//tools/foo');
});

test('two folders of one repository are two rows, not one overwriting the other', async () => {
  const m = machine();
  for (const [under, name] of [
    ['tools/foo', 'foo-sdk'],
    ['tools/bar', 'bar-sdk'],
  ] as const) {
    const { wiring } = githubWiring({
      repo: 'acme/mono',
      path: under,
      manifest: { name },
    });
    await quietly(() =>
      installPlugin({
        brand: brand(),
        plugin: `acme/mono/${under}`,
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring,
      }),
    );
  }

  assert.deepEqual(
    rowsOf(m)
      .map((r) => r.repo)
      .sort(),
    ['github:acme/mono//tools/bar', 'github:acme/mono//tools/foo'],
  );
});

test('a ref spelled after the repo wins over --ref, and the flag is not swallowed', async () => {
  const m = machine();
  const { wiring, fetched } = githubWiring({ repo: 'acme/thing', ref: 'v2' });
  const con = silenceConsole();
  try {
    await installPlugin({
      brand: brand(),
      plugin: 'acme/thing@v2',
      ref: 'v9',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    });
  } finally {
    con.restore();
  }

  assert.deepEqual(fetched, [{ repo: 'acme/thing', ref: 'v2', sourcePath: null }]);
  assert.equal(rowsOf(m)[0]?.ref, 'v2');
  assert.match(flat(con), /--ref v9 was not used/);
});

test('installing into Claude Code fetches the files and stages them', async () => {
  const m = claudeMachine();
  const { wiring, fetched } = githubWiring({ repo: 'acme/thing' });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['claude'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  assert.deepEqual(report.targets, ['claude']);
  assert.equal(fetched.length, 1, 'the files are needed even though no editor copies them');

  const root = localMarketplace(m.pathOpts).dir.toString();
  assert.ok(fs.existsSync(path.join(root, 'plugins', 'my-sdk', 'plugin.json')));
  assert.ok(
    m.calls.includes(`plugin install my-sdk@${LOCAL_MARKETPLACE} --scope user`),
    `expected the generated marketplace to be addressed, got: ${m.calls.join(' | ')}`,
  );
});

test('a repository that is a marketplace says which flag it belongs to', async () => {
  const m = machine();
  const { wiring } = githubWiring({
    repo: 'acme/market',
    manifest: null,
    routes: {
      [rawUrl('acme/market', 'main', '.claude-plugin/marketplace.json')]: {
        body: { name: 'acme', plugins: [{ name: 'my-sdk' }] },
      },
    },
  });

  await assert.rejects(
    () =>
      quietly(() =>
        installPlugin({
          brand: brand(),
          plugin: 'acme/market',
          targets: ['cursor'],
          assumeYes: true,
          pathOpts: m.pathOpts,
          wiring,
        }),
      ),
    /is a marketplace/,
  );
  assert.deepEqual(rowsOf(m), []);
});

test('a repository that declares no plugin at all fails before anything is copied', async () => {
  const m = machine();
  const { wiring } = githubWiring({ repo: 'acme/empty', manifest: null });

  await assert.rejects(
    () =>
      quietly(() =>
        installPlugin({
          brand: brand(),
          plugin: 'acme/empty',
          targets: ['cursor'],
          assumeYes: true,
          pathOpts: m.pathOpts,
          wiring,
        }),
      ),
    /does not look like a plugin/,
  );
  assert.deepEqual(rowsOf(m), []);
});

test('the repository is named, and the warning about what a plugin can run is said', async () => {
  const m = machine();
  const { wiring } = githubWiring({ repo: 'acme/mono', path: 'tools/foo' });
  const con = silenceConsole();
  try {
    await installPlugin({
      brand: brand(),
      plugin: 'acme/mono/tools/foo',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    });
  } finally {
    con.restore();
  }
  const said = flat(con);
  assert.match(said, /acme\/mono\/tools\/foo@main/);
  assert.match(said, /not from Claude Code's marketplace/);
  assert.match(said, /can run commands/);
});

test('declining the repository installs nothing and is not a failure', async () => {
  const m = machine();
  const { wiring, fetched, asked } = githubWiring({ repo: 'acme/thing' });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor'],
      ask: () => false,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  assert.deepEqual(report.targets, []);
  assert.deepEqual(rowsOf(m), [], 'nothing recorded');
  assert.deepEqual(fetched, [], 'and none of its files fetched: the question comes first');
  // The one request is the manifest read, which is how the question names the plugin.
  assert.equal(asked.length, 1);
});

test('telemetry reports the repository kind, and never the repository', async () => {
  const m = machine();
  const events: Tracked[] = [];
  const { wiring } = githubWiring({ repo: 'acme/private-thing', path: 'tools/secret' });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/private-thing/tools/secret',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
      sink: sinkInto(events),
    }),
  );

  const installed = events.filter((e) => e.name === 'Context Plugin Installed');
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.properties.source_kind, 'github');
  assert.equal(installed[0]?.properties.plugin, null);
  assert.equal(installed[0]?.properties.marketplace, 'custom');
  for (const event of events) {
    for (const value of Object.values(event.properties)) {
      assert.ok(
        typeof value !== 'string' || !/private-thing|secret|my-sdk/.test(value),
        `a repository reached telemetry: ${String(value)}`,
      );
    }
  }
});

test('a run that fails before reading the manifest reports no plugin at all', async () => {
  const m = machine();
  const events: Tracked[] = [];
  const { wiring } = githubWiring({ repo: 'acme/empty', manifest: null });

  await quietly(async () => {
    await assert.rejects(() =>
      installPlugin({
        brand: brand(),
        plugin: 'acme/empty',
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring,
        sink: sinkInto(events),
      }),
    );
  });

  const failed = events.filter((e) => e.name === 'Context Plugin Install Failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.properties.source_kind, 'github');
  assert.equal(failed[0]?.properties.stage, 'resolve');
  assert.equal(failed[0]?.properties.plugin, null, 'the id was never learned');
});

test('uninstalling by its id finds the row a repository install keyed by slug', async () => {
  const m = claudeMachine();
  const { wiring } = githubWiring({ repo: 'acme/thing' });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor', 'claude'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );
  assert.equal(rowsOf(m).length, 1);

  const report = await quietly(() =>
    uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['cursor', 'claude'],
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  assert.deepEqual(report.targets.sort(), ['claude', 'cursor']);
  assert.deepEqual(rowsOf(m), []);
  assert.ok(!fs.existsSync(localMarketplace(m.pathOpts).dir.toString()));
});

test('uninstall telemetry reports the repository kind without a registry read', async () => {
  const m = machine();
  const events: Tracked[] = [];
  const { wiring } = githubWiring({ repo: 'acme/thing' });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );
  await quietly(() =>
    uninstallPlugin({
      brand: brand(),
      plugin: 'my-sdk',
      targets: ['cursor'],
      pathOpts: m.pathOpts,
      wiring,
      sink: sinkInto(events),
    }),
  );

  const removed = events.filter((e) => e.name === 'Context Plugin Uninstalled');
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.properties.source_kind, 'github');
  assert.equal(removed[0]?.properties.marketplace, 'custom');
});

test('update re-fetches a repository row at the ref its own row recorded', async () => {
  const m = machine();
  const { wiring, fetched } = githubWiring({ repo: 'acme/mono', ref: 'v2', path: 'tools/foo' });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/mono/tools/foo@v2',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  const report = await quietly(() => updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring }));

  assert.deepEqual(
    report.rows.map((r) => r.outcome),
    ['updated'],
  );
  assert.deepEqual(report.failed, []);
  assert.deepEqual(fetched, [
    { repo: 'acme/mono', ref: 'v2', sourcePath: 'tools/foo' },
    { repo: 'acme/mono', ref: 'v2', sourcePath: 'tools/foo' },
  ]);
});

test('a repository row reports its kind and no id when it re-syncs', async () => {
  const m = machine();
  const events: Tracked[] = [];
  const { wiring } = githubWiring({ repo: 'acme/thing' });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );
  await quietly(() =>
    updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring, sink: sinkInto(events) }),
  );

  const installed = events.filter((e) => e.name === 'Context Plugin Installed');
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.properties.source_kind, 'github');
  assert.equal(installed[0]?.properties.plugin, null, 'the same rule as the install');
  assert.equal(installed[0]?.properties.marketplace, 'custom');
});

test('a repository that is no longer readable fails its row, rather than reading as gone', async () => {
  // Unlike a path row: a 404 and an upstream outage are not distinguishable from here.
  const m = machine();
  const { wiring } = githubWiring({ repo: 'acme/thing' });
  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: 'acme/thing',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring,
    }),
  );

  const { wiring: gone } = githubWiring({ repo: 'acme/thing', manifest: null });
  const report = await quietly(() =>
    updateAll({ brand: brand(), pathOpts: m.pathOpts, wiring: gone }),
  );

  assert.deepEqual(
    report.rows.map((r) => r.outcome),
    ['failed'],
  );
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0]?.error ?? '', /does not look like a plugin/);
});
