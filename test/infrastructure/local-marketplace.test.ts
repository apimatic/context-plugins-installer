import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  localMarketplace,
  stageLocalPlugin,
  unstageLocalPlugin,
} from '../../src/infrastructure/local-marketplace.js';
import { LOCAL_MARKETPLACE } from '../../src/types/brand.js';
import type { PathOpts } from '../../src/types/env.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import type { Failure } from '../../src/types/failure.js';
import type { Result } from '../../src/types/result.js';
import { cleanupAll, tmpDir } from '../helpers.js';

test.after(cleanupAll);

// The generated marketplace is shared state on disk: several plugins live in one
// registry file, and a hand edit or a newer CLI can reach it. What matters here
// is that staging one plugin never takes another's row out with it.

function sandbox(): { opts: PathOpts; root: DirectoryPath; registry: string } {
  const home = tmpDir('cp-mkt-');
  const opts: PathOpts = { env: { CP_STATE_DIR: path.join(home, 'state') }, home };
  const root = localMarketplace(opts).dir;
  return { opts, root, registry: path.join(root.toString(), '.claude-plugin', 'marketplace.json') };
}

function pluginDir(name: string, contents = '# a skill'): DirectoryPath {
  const dir = path.join(tmpDir('cp-src-'), name);
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'SKILL.md'), contents);
  return new DirectoryPath(dir);
}

const registryOf = (at: string): { name?: unknown; plugins?: unknown[] } =>
  JSON.parse(fs.readFileSync(at, 'utf8')) as { name?: unknown; plugins?: unknown[] };

const value = <T>(result: Result<T, Failure>): T => {
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
};

test('staging writes the files, the registry, and the name Claude will address', () => {
  const s = sandbox();
  const origin = value(stageLocalPlugin({ plugin: 'my-sdk', srcDir: pluginDir('my-sdk') }, s.opts));

  assert.equal(origin.name, LOCAL_MARKETPLACE);
  assert.ok(origin.dir.isEqual(s.root));
  assert.ok(fs.existsSync(path.join(s.root.toString(), 'plugins', 'my-sdk', 'skills', 'SKILL.md')));

  const registry = registryOf(s.registry);
  assert.equal(registry.name, LOCAL_MARKETPLACE);
  assert.deepEqual(registry.plugins, [{ name: 'my-sdk', source: './plugins/my-sdk' }]);
});

test('a description is carried into the entry when there is one', () => {
  const s = sandbox();
  stageLocalPlugin({ plugin: 'my-sdk', srcDir: pluginDir('my-sdk'), description: 'Local' }, s.opts);
  assert.deepEqual(registryOf(s.registry).plugins, [
    { name: 'my-sdk', source: './plugins/my-sdk', description: 'Local' },
  ]);
});

test('a second plugin joins the same marketplace rather than replacing it', () => {
  const s = sandbox();
  stageLocalPlugin({ plugin: 'first', srcDir: pluginDir('first') }, s.opts);
  stageLocalPlugin({ plugin: 'second', srcDir: pluginDir('second') }, s.opts);

  const names = (registryOf(s.registry).plugins ?? []).map((p) => (p as { name: string }).name);
  assert.deepEqual(names, ['first', 'second']);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(s.root.toString(), 'plugins', name)), name);
  }
});

test('re-staging replaces one entry and one folder, and nothing else', () => {
  const s = sandbox();
  stageLocalPlugin({ plugin: 'first', srcDir: pluginDir('first') }, s.opts);
  stageLocalPlugin({ plugin: 'my-sdk', srcDir: pluginDir('my-sdk', 'v1') }, s.opts);
  stageLocalPlugin({ plugin: 'my-sdk', srcDir: pluginDir('my-sdk', 'v2') }, s.opts);

  const rows = registryOf(s.registry).plugins ?? [];
  assert.equal(rows.length, 2, 'one row per plugin, not one per staging');
  assert.equal(
    fs.readFileSync(
      path.join(s.root.toString(), 'plugins', 'my-sdk', 'skills', 'SKILL.md'),
      'utf8',
    ),
    'v2',
    'the files are a fresh snapshot',
  );
});

test('a shrinking plugin leaves no orphan files behind', () => {
  const s = sandbox();
  const first = pluginDir('my-sdk');
  fs.writeFileSync(path.join(first.toString(), 'skills', 'gone.md'), 'removed later');
  stageLocalPlugin({ plugin: 'my-sdk', srcDir: first }, s.opts);
  stageLocalPlugin({ plugin: 'my-sdk', srcDir: pluginDir('my-sdk') }, s.opts);

  const staged = path.join(s.root.toString(), 'plugins', 'my-sdk', 'skills');
  assert.deepEqual(fs.readdirSync(staged), ['SKILL.md']);
});

test('a row this build did not write rides through a staging verbatim', () => {
  // The rule the record already follows: shared state, so a row belonging to a
  // hand edit or a newer CLI is not this build's to drop.
  const s = sandbox();
  stageLocalPlugin({ plugin: 'mine', srcDir: pluginDir('mine') }, s.opts);
  const foreign = { name: 'theirs', source: { source: 'npm', package: '@x/y' }, future: true };
  const rows = [...(registryOf(s.registry).plugins ?? []), foreign];
  fs.writeFileSync(s.registry, JSON.stringify({ name: LOCAL_MARKETPLACE, plugins: rows }));

  stageLocalPlugin({ plugin: 'mine', srcDir: pluginDir('mine') }, s.opts);
  const after = registryOf(s.registry).plugins ?? [];
  assert.deepEqual(
    after.find((p) => (p as { name: string }).name === 'theirs'),
    foreign,
  );
});

test('unstaging removes one plugin and reports what is left', () => {
  const s = sandbox();
  stageLocalPlugin({ plugin: 'first', srcDir: pluginDir('first') }, s.opts);
  stageLocalPlugin({ plugin: 'second', srcDir: pluginDir('second') }, s.opts);

  const left = value(unstageLocalPlugin({ plugin: 'first' }, s.opts));
  assert.deepEqual(left, { remaining: 1, removed: false });
  assert.equal(fs.existsSync(path.join(s.root.toString(), 'plugins', 'first')), false);
  assert.ok(fs.existsSync(path.join(s.root.toString(), 'plugins', 'second')));
  assert.deepEqual(
    (registryOf(s.registry).plugins ?? []).map((p) => (p as { name: string }).name),
    ['second'],
  );
});

test('the last plugin out takes the whole marketplace with it', () => {
  // An empty generated marketplace is a row in `claude plugin marketplace list`
  // that offers nothing, so the caller is told to drop the registration too.
  const s = sandbox();
  stageLocalPlugin({ plugin: 'only', srcDir: pluginDir('only') }, s.opts);

  assert.deepEqual(value(unstageLocalPlugin({ plugin: 'only' }, s.opts)), {
    remaining: 0,
    removed: true,
  });
  assert.equal(fs.existsSync(s.root.toString()), false);
});

test('unstaging from nothing is not a failure', () => {
  const s = sandbox();
  assert.deepEqual(value(unstageLocalPlugin({ plugin: 'never-there' }, s.opts)), {
    remaining: 0,
    removed: true,
  });
});

test('an unreadable registry does not make every path install fail forever', () => {
  const s = sandbox();
  stageLocalPlugin({ plugin: 'mine', srcDir: pluginDir('mine') }, s.opts);
  fs.writeFileSync(s.registry, '{ truncated');

  const origin = value(stageLocalPlugin({ plugin: 'mine', srcDir: pluginDir('mine') }, s.opts));
  assert.equal(origin.name, LOCAL_MARKETPLACE);
  assert.deepEqual(registryOf(s.registry).plugins, [{ name: 'mine', source: './plugins/mine' }]);
});

test('it writes under the state dir it is given, never a real home', () => {
  const s = sandbox();
  stageLocalPlugin({ plugin: 'my-sdk', srcDir: pluginDir('my-sdk') }, s.opts);
  assert.ok(s.root.toString().startsWith(String(s.opts.env?.CP_STATE_DIR)));
});
