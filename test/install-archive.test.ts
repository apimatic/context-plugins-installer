import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { localMarketplace } from '../src/infrastructure/local-marketplace.js';
import { readRaw } from '../src/infrastructure/manifest-store.js';
import * as paths from '../src/infrastructure/paths.js';
import { LOCAL_MARKETPLACE } from '../src/types/brand.js';
import { archiveAt, gzipOf, tarOf, zipOf } from './archive-fixture.js';
import {
  archiveWiring,
  brandFor,
  claudeMachine,
  flat,
  installPlugin,
  machine,
  quietly,
  sinkInto,
  uninstallPlugin,
  updateAll,
  type Machine,
  type Tracked,
} from './install-fixture.js';
import { cleanupAll, silenceConsole, stubFetch } from './helpers.js';

test.after(cleanupAll);

// Installing a plugin from an archive, end to end: the real download, the real
// reader, a real extraction into a sandboxed machine.

const REPO = 'acme/plugin-marketplace';
const brand = () => brandFor(REPO);
const MANIFEST = '.claude-plugin/plugin.json';
const URL = 'https://acme.com/my-sdk.zip';

const manifest = (name = 'my-sdk'): string =>
  JSON.stringify({ name, description: 'A plugin from an archive', version: '0.1.0' });

const entries = (name = 'my-sdk', under = ''): { name: string; data: string }[] => [
  { name: `${under}${MANIFEST}`, data: manifest(name) },
  { name: `${under}skills/thing/SKILL.md`, data: '# thing' },
];

const rowsOf = (m: Machine): Record<string, unknown>[] =>
  readRaw(paths.manifestPath(m.pathOpts)).plugins as Record<string, unknown>[];

const cursorDir = (m: Machine, plugin: string): string =>
  path.join(m.pathOpts.env.CP_CURSOR_DIR, 'plugins', 'local', plugin);

const served = (routes: Record<string, Buffer>) =>
  stubFetch(Object.fromEntries(Object.entries(routes).map(([url, bytes]) => [url, { bytes }])));

test('a zip at a URL is downloaded, unpacked and installed', async () => {
  const m = machine();
  const fetchImpl = served({ [URL]: zipOf(entries()) });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['cursor', 'vscode'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );

  assert.deepEqual(report.targets, ['cursor', 'vscode']);
  assert.equal(report.ref, null, 'an archive is whatever it is today');
  assert.deepEqual(fetchImpl.calls, [URL], 'one request, and no registry read');
  assert.ok(fs.existsSync(path.join(cursorDir(m, 'my-sdk'), MANIFEST.split('/')[0] as string)));
  assert.equal(
    fs.readFileSync(path.join(cursorDir(m, 'my-sdk'), 'skills', 'thing', 'SKILL.md'), 'utf8'),
    '# thing',
  );

  assert.equal(rowsOf(m).length, 1);
  assert.equal(rowsOf(m)[0]?.repo, `archive:${URL}`);
  assert.equal(rowsOf(m)[0]?.plugin, 'my-sdk');
  assert.equal(rowsOf(m)[0]?.ref, null);
});

test('a tarball is the same install, over the same one request', async () => {
  const m = machine();
  const url = 'https://acme.com/my-sdk.tar.gz';
  const fetchImpl = served({ [url]: gzipOf(tarOf(entries())) });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: url,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );
  assert.deepEqual(report.targets, ['cursor']);
  assert.ok(fs.existsSync(cursorDir(m, 'my-sdk')));
});

test('a body that cannot be streamed is read whole instead', async () => {
  const m = machine();
  const fetchImpl = stubFetch({ [URL]: { bytes: zipOf(entries()), noStream: true } });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );
  assert.ok(fs.existsSync(cursorDir(m, 'my-sdk')));
});

test('a wrapped archive is unwrapped, and a folder inside it is found under the wrapper', async () => {
  // The shape of every archive GitHub builds, and the fragment a user copies
  // off the page - which does not mention the wrapper.
  const m = machine();
  const url = 'https://github.com/acme/mono/archive/refs/heads/main.zip';
  const archive = zipOf([
    { name: 'mono-main/README.md', data: 'read me' },
    ...entries('foo-sdk', 'mono-main/tools/foo/'),
    ...entries('bar-sdk', 'mono-main/tools/bar/'),
  ]);
  const fetchImpl = served({ [url]: archive });

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: `${url}#tools/foo`,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );

  assert.equal(rowsOf(m)[0]?.plugin, 'foo-sdk');
  assert.equal(rowsOf(m)[0]?.repo, `archive:${url}#tools/foo`);
  assert.ok(fs.existsSync(path.join(cursorDir(m, 'foo-sdk'), 'skills', 'thing', 'SKILL.md')));
  assert.equal(fs.existsSync(cursorDir(m, 'bar-sdk')), false, 'only the folder named');
});

test('an archive on this machine installs without a request', async () => {
  const m = machine();
  const file = archiveAt('my-sdk.zip', zipOf(entries()));
  const fetchImpl = served({});

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: file.toString(),
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );

  assert.deepEqual(fetchImpl.calls, []);
  assert.equal(rowsOf(m)[0]?.repo, `archive:${file.toString()}`);
  assert.ok(fs.existsSync(cursorDir(m, 'my-sdk')));
});

test('the question comes before the download, so a declined archive is never fetched', async () => {
  const m = machine();
  const fetchImpl = served({ [URL]: zipOf(entries()) });

  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['cursor'],
      ask: () => false,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );

  assert.deepEqual(report.targets, []);
  assert.deepEqual(fetchImpl.calls, [], 'not a byte of a source the user declined');
  assert.deepEqual(rowsOf(m), []);
});

test('two plugins from one archive cost one download', async () => {
  const m = machine();
  const url = 'https://acme.com/mono.zip';
  const archive = zipOf([
    { name: 'README.md', data: 'read me' },
    ...entries('foo-sdk', 'tools/foo/'),
    ...entries('bar-sdk', 'tools/bar/'),
  ]);
  const fetchImpl = served({ [url]: archive });

  for (const folder of ['tools/foo', 'tools/bar']) {
    await quietly(() =>
      installPlugin({
        brand: brand(),
        plugin: `${url}#${folder}`,
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: archiveWiring(fetchImpl, m.pathOpts),
      }),
    );
  }
  assert.equal(fetchImpl.calls.length, 2, 'two runs, two downloads');

  // One run over both rows: the session memoises on the archive, so the second
  // row is unpacked from the first row's download.
  fetchImpl.calls.length = 0;
  const report = await quietly(() =>
    updateAll({
      brand: brand(),
      pathOpts: m.pathOpts,
      wiring: archiveWiring(fetchImpl, m.pathOpts),
    }),
  );
  assert.deepEqual(
    report.rows.map((r) => r.outcome),
    ['updated', 'updated'],
  );
  assert.deepEqual(fetchImpl.calls, [url], 'and one download between them');
});

test('an archive that has left the machine is reported, not failed', async () => {
  const m = machine();
  const file = archiveAt('gone.zip', zipOf(entries()));
  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: file.toString(),
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({}), m.pathOpts),
    }),
  );
  fs.rmSync(file.toString());

  const report = await quietly(() =>
    updateAll({
      brand: brand(),
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({}), m.pathOpts),
    }),
  );
  assert.equal(report.rows[0]?.outcome, 'failed', 'the archive is gone, and says so');
  assert.equal(rowsOf(m).length, 1, 'and the row stays: the copy in the editor is still there');
});

test('a URL that answers with a web page says that, rather than blaming the plugin', async () => {
  const m = machine();
  const fetchImpl = stubFetch({ [URL]: { body: '<!DOCTYPE html><html>nope</html>' } });

  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brand(),
        plugin: URL,
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: archiveWiring(fetchImpl, m.pathOpts),
      }),
    ),
    /is not a zip or a tarball/,
  );
});

test('an archive with no plugin in it names the archive, never the workspace', async () => {
  const m = machine();
  const fetchImpl = served({ [URL]: zipOf([{ name: 'README.md', data: 'read me' }]) });

  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brand(),
        plugin: URL,
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: archiveWiring(fetchImpl, m.pathOpts),
      }),
    ),
    (e: Error) => {
      assert.match(e.message, /my-sdk\.zip does not look like a plugin/);
      assert.ok(!e.message.includes('work'), 'the workspace is nobody the user typed');
      return true;
    },
  );
});

test('an http URL is refused where it is written, naming https', async () => {
  const m = machine();
  await assert.rejects(
    quietly(() =>
      installPlugin({
        brand: brand(),
        plugin: 'http://acme.com/my-sdk.zip',
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: archiveWiring(served({}), m.pathOpts),
      }),
    ),
    /is not an https URL/,
  );
});

test('a --ref alongside an archive is said out loud rather than dropped', async () => {
  const m = machine();
  const con = silenceConsole();
  try {
    await installPlugin({
      brand: brand(),
      plugin: URL,
      ref: 'v2',
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({ [URL]: zipOf(entries()) }), m.pathOpts),
    });
  } finally {
    con.restore();
  }
  assert.match(flat(con), /--ref v2 was not used/);
});

test('installing into Claude Code stages the unpacked files', async () => {
  const m = claudeMachine();
  const report = await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['claude'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({ [URL]: zipOf(entries()) }), m.pathOpts),
    }),
  );

  assert.deepEqual(report.targets, ['claude']);
  const root = localMarketplace(m.pathOpts).dir.toString();
  assert.ok(fs.existsSync(path.join(root, 'plugins', 'my-sdk', 'skills', 'thing', 'SKILL.md')));
  assert.ok(m.calls.includes(`plugin install my-sdk@${LOCAL_MARKETPLACE} --scope user`));
});

test('uninstalling takes the copy and the row, and leaves the archive alone', async () => {
  const m = machine();
  const file = archiveAt('my-sdk.zip', zipOf(entries()));
  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: file.toString(),
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({}), m.pathOpts),
    }),
  );

  await quietly(() =>
    uninstallPlugin({
      plugin: 'my-sdk',
      brand: brand(),
      targets: ['cursor'],
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({}), m.pathOpts),
    }),
  );

  assert.deepEqual(rowsOf(m), []);
  assert.equal(fs.existsSync(cursorDir(m, 'my-sdk')), false);
  assert.ok(fs.existsSync(file.toString()), 'the archive it came from is not ours to delete');
});

test('telemetry reports the kind and withholds the URL and the name', async () => {
  const m = machine();
  const events: Tracked[] = [];

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({ [URL]: zipOf(entries()) }), m.pathOpts),
      sink: sinkInto(events),
    }),
  );

  const installed = events.find((e) => e.name === 'Context Plugin Installed');
  assert.ok(installed, 'an install was reported');
  assert.equal(installed.properties.source_kind, 'archive');
  assert.equal(installed.properties.plugin, null, 'named by its own author, and it stays here');
  assert.equal(installed.properties.marketplace, 'custom');
  const sent = JSON.stringify(events);
  assert.ok(!sent.includes('acme.com'), 'the host never leaves the machine');
  assert.ok(!sent.includes('my-sdk'), 'and neither does the name');
});

test('the workspace is cleaned up, and nothing of the download is left behind', async () => {
  const m = machine();
  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({ [URL]: zipOf(entries()) }), m.pathOpts),
    }),
  );
  const work = paths.workspaceDir(m.pathOpts).toString();
  const left = fs.existsSync(work) ? fs.readdirSync(work) : [];
  assert.deepEqual(left, [], `the workspace still holds ${left.join(', ')}`);
});

test('a temp directory of a run that died is swept, and a live one is not', async () => {
  const m = machine();
  const work = paths.workspaceDir(m.pathOpts).toString();
  fs.mkdirSync(work, { recursive: true });
  const stale = path.join(work, 'archive-stale');
  const fresh = path.join(work, 'archive-fresh');
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  const old = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(stale, old / 1000, old / 1000);

  await quietly(() =>
    installPlugin({
      brand: brand(),
      plugin: URL,
      targets: ['cursor'],
      assumeYes: true,
      pathOpts: m.pathOpts,
      wiring: archiveWiring(served({ [URL]: zipOf(entries()) }), m.pathOpts),
    }),
  );

  assert.equal(fs.existsSync(stale), false, 'a day-old workspace is nobody`s');
  assert.ok(fs.existsSync(fresh), 'and a fresh one may be another run of this tool');
});

test('a plugin from a folder in the same tmp directory is still its own install', async () => {
  // Two archives, one plugin id each: the record keys on the archive, so these
  // are two rows rather than one overwriting the other.
  const m = machine();
  const first = archiveAt('one.zip', zipOf(entries('a-sdk')));
  const second = archiveAt('two.zip', zipOf(entries('b-sdk')));
  for (const file of [first, second]) {
    await quietly(() =>
      installPlugin({
        brand: brand(),
        plugin: file.toString(),
        targets: ['cursor'],
        assumeYes: true,
        pathOpts: m.pathOpts,
        wiring: archiveWiring(served({}), m.pathOpts),
      }),
    );
  }
  assert.deepEqual(
    rowsOf(m)
      .map((r) => r.plugin)
      .sort(),
    ['a-sdk', 'b-sdk'],
  );
});
