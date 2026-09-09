import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';

import { openManifest, upsert } from '../../src/infrastructure/manifest-store.js';
import * as paths from '../../src/infrastructure/paths.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import { ok } from '../../src/types/result.js';
import { isPlainObject } from '../../src/types/util.js';
import { rawUrl, registryClient } from '../../src/infrastructure/github-registry-client.js';
import { foreignTargets } from '../../src/types/installed-record.js';
import { cleanupAll, portsFor, silenceConsole, stubFetch } from '../helpers.js';
import {
  brandFor,
  installPlugin,
  machine,
  pluginSource,
  quietly,
  scriptedConfirm,
  TARGETS,
  type Wiring,
  updateAll,
  wiring,
} from '../install-fixture.js';

test.after(cleanupAll);

// `update` is one install per recorded row, so what it is tested for is the
// row-shape handling around them: which rows it refuses, which it skips, which
// it refreshes, and what it leaves on disk for a build that is not this one.

// `update` refreshing a plugin for an editor that is no longer installed is a
// no-op, not a failure - otherwise the row makes `update` exit 1 forever, and
// this branch made such a row need --force to clear.
test('update skips a row whose editors are all gone instead of failing', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const brand = brandFor(repo);
  const d = wiring({ repo, srcDir });

  await quietly(() =>
    installPlugin({
      brand,
      plugin: 'my-sdk',
      targets: ['cursor'],
      wiring: d,
      pathOpts: m.pathOpts,
    }),
  );
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });

  const result = await quietly(() => updateAll({ brand, wiring: d, pathOpts: m.pathOpts }));

  assert.deepEqual(result.failed, [], 'no editor for it is not a failure');
  assert.deepEqual(result.updated, []);
});

test('update never re-asks, it replays the recorded harnesses', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const d = wiring({ repo, srcDir });

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: null,
      wiring: d,
      ask: scriptedConfirm([false, true]),
      pathOpts: m.pathOpts,
    }),
  );

  const confirm = scriptedConfirm([]);
  await quietly(() => updateAll({ brand: brandFor(repo), wiring: d, pathOpts: m.pathOpts }));

  assert.deepEqual(confirm.asked, []);
  assert.deepEqual(openManifest(paths.manifestPath(m.pathOpts)).list()[0].targets, ['vscode']);
});

test('update names the targets it cannot update, and leaves them recorded', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const d = wiring({ repo, srcDir: pluginSource() });
  const file = paths.manifestPath(m.pathOpts).toString();

  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      wiring: d,
      pathOpts: m.pathOpts,
    }),
  );
  // As if a newer CLI had installed the same plugin into an editor this build
  // knows nothing about.
  const raw = openManifest(file).findRaw({ plugin: 'my-sdk', repo });
  assert.ok(raw);
  upsert(file, { ...raw, targets: [...TARGETS, 'zed'] });

  const con = silenceConsole();
  try {
    await updateAll({ brand: brandFor(repo), wiring: d, pathOpts: m.pathOpts });
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
    foreignTargets(openManifest(file).findRaw({ plugin: 'my-sdk', repo })),
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
  // Two plugins from one repo: the fetcher hands each its own folder, so the
  // memo is what decides how often the registry is read.
  const ports = portsFor(fetchImpl);
  const d: Wiring = {
    ports,
    registry: registryClient(ports),
    fetcher: {
      openRepo: async () => ({
        via: 'api',
        cleanup: () => {},
        checkout: async (sourcePath: string) =>
          ok(new DirectoryPath(pluginSource(sourcePath.split('/').pop()))),
      }),
    },
  };

  for (const plugin of ['alpha', 'beta']) {
    await quietly(() =>
      installPlugin({
        brand: brandFor(repo),
        plugin,
        targets: TARGETS,
        wiring: d,
        pathOpts: m.pathOpts,
      }),
    );
  }

  const before = fetchImpl.calls.filter((u) => u === registry).length;
  const result = await quietly(() =>
    updateAll({ brand: brandFor(repo), wiring: d, pathOpts: m.pathOpts }),
  );

  const during = fetchImpl.calls.filter((u) => u === registry).length - before;
  assert.deepEqual(result.updated.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.failed, []);
  assert.equal(during, 1, `expected one registry read for two plugins, got ${during}`);
});

test('update fails loudly on rows it cannot read instead of skipping them', async () => {
  const m = machine();
  const repo = 'context-plugins/plugin-marketplace';
  const srcDir = pluginSource();
  const d = wiring({ repo, srcDir });

  // One good install on record, plus a row only a newer CLI understands.
  await quietly(() =>
    installPlugin({
      brand: brandFor(repo),
      plugin: 'my-sdk',
      targets: TARGETS,
      wiring: d,
      pathOpts: m.pathOpts,
    }),
  );
  const file = paths.manifestPath(m.pathOpts).toString();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.plugins.push({ plugin: 'future-sdk', repo, marketplace: 'apimatic', targets: ['zed'] });
  fs.writeFileSync(file, JSON.stringify(raw));

  const result = await quietly(() =>
    updateAll({ brand: brandFor(repo), wiring: d, pathOpts: m.pathOpts }),
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
