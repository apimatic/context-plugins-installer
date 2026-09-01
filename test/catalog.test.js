'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolvePlugin, loadCatalog, sourcePathFor, rawUrl, ghHeaders } = require('../src/catalog');
const { UserError } = require('../src/util');
const { stubFetch } = require('./helpers');

const REPO = 'context-plugins/plugin-marketplace';
const CLAUDE_REG = rawUrl(REPO, 'main', '.claude-plugin/marketplace.json');
const CURSOR_REG = rawUrl(REPO, 'main', '.cursor-plugin/marketplace.json');

const registry = (over = {}) => ({
  name: 'apimatic',
  plugins: [
    { name: 'my-sdk', source: './plugins/my-sdk', description: 'A test SDK plugin' },
    { name: 'other-sdk', source: './plugins/other-sdk' },
  ],
  ...over,
});

const deps = (routes) => ({ fetchImpl: stubFetch(routes), env: {} });

test('the marketplace name is derived from the registry, not hardcoded', async () => {
  const resolved = await resolvePlugin({
    repo: REPO,
    ref: 'main',
    plugin: 'my-sdk',
    deps: deps({ [CLAUDE_REG]: { body: registry({ name: 'acme' }) } }),
  });
  assert.equal(resolved.marketplace, 'acme');
});

test('an explicit marketplace overrides the registry value', async () => {
  const resolved = await resolvePlugin({
    repo: REPO,
    ref: 'main',
    plugin: 'my-sdk',
    marketplace: 'override',
    deps: deps({ [CLAUDE_REG]: { body: registry() } }),
  });
  assert.equal(resolved.marketplace, 'override');
});

test('the source path is normalized and the description carried through', async () => {
  const resolved = await resolvePlugin({
    repo: REPO,
    ref: 'main',
    plugin: 'my-sdk',
    deps: deps({ [CLAUDE_REG]: { body: registry() } }),
  });
  assert.equal(resolved.sourcePath, 'plugins/my-sdk');
  assert.equal(resolved.description, 'A test SDK plugin');
  assert.equal(resolved.catalogFound, true);
});

test('the Cursor registry is used when the Claude one is absent', async () => {
  const catalog = await loadCatalog({
    repo: REPO,
    ref: 'main',
    deps: deps({ [CURSOR_REG]: { body: registry({ name: 'cursor-brand' }) } }),
  });
  assert.equal(catalog.marketplace, 'cursor-brand');
  assert.equal(catalog.from, '.cursor-plugin/marketplace.json');
});

test('a marketplace name with spaces is rejected with the schema rule', async () => {
  await assert.rejects(
    resolvePlugin({
      repo: REPO,
      ref: 'main',
      plugin: 'my-sdk',
      deps: deps({ [CLAUDE_REG]: { body: registry({ name: 'Context Plugins' }) } }),
    }),
    (err) =>
      err instanceof UserError &&
      /not a valid identifier/.test(err.message) &&
      /kebab-case/.test(err.hint),
  );
});

test('ordinary marketplace identifiers still pass', async () => {
  for (const name of ['apimatic', 'context-plugins', 'acme_2', 'a.b']) {
    const resolved = await resolvePlugin({
      repo: REPO,
      ref: 'main',
      plugin: 'my-sdk',
      deps: deps({ [CLAUDE_REG]: { body: registry({ name }) } }),
    });
    assert.equal(resolved.marketplace, name);
  }
});

test('a mistyped plugin name suggests the closest match', async () => {
  await assert.rejects(
    resolvePlugin({
      repo: REPO,
      ref: 'main',
      plugin: 'my-sdkk',
      deps: deps({ [CLAUDE_REG]: { body: registry() } }),
    }),
    (err) =>
      err instanceof UserError &&
      /not listed/.test(err.message) &&
      /Did you mean: my-sdk/.test(err.hint),
  );
});

test('a plugin with no near match points at the list command and the count', async () => {
  await assert.rejects(
    resolvePlugin({
      repo: REPO,
      ref: 'main',
      plugin: 'zzzzzzzzzzzzzzzz',
      deps: deps({ [CLAUDE_REG]: { body: registry() } }),
    }),
    (err) => err instanceof UserError && /Run 'list' to see the 2 available/.test(err.hint),
  );
});

test('no registry at all asks for --marketplace instead of guessing', async () => {
  await assert.rejects(
    resolvePlugin({ repo: REPO, ref: 'main', plugin: 'my-sdk', deps: deps({}) }),
    (err) => err instanceof UserError && /--marketplace/.test(err.hint),
  );
});

test('no registry plus an explicit marketplace falls back to plugins/<id>', async () => {
  const resolved = await resolvePlugin({
    repo: REPO,
    ref: 'main',
    plugin: 'my-sdk',
    marketplace: 'acme',
    deps: deps({}),
  });
  assert.equal(resolved.sourcePath, 'plugins/my-sdk');
  assert.equal(resolved.catalogFound, false);
});

test('sourcePathFor normalizes the shapes a registry can use', () => {
  assert.equal(sourcePathFor({ source: './plugins/x' }, 'x'), 'plugins/x');
  assert.equal(sourcePathFor({ source: 'plugins/x/' }, 'x'), 'plugins/x');
  assert.equal(sourcePathFor({ source: '/plugins/x' }, 'x'), 'plugins/x');
  assert.equal(sourcePathFor(undefined, 'x'), 'plugins/x');
  assert.equal(sourcePathFor('x', 'x'), 'plugins/x');
});

test('a traversal attempt in source is ignored', () => {
  assert.equal(sourcePathFor({ source: '../../etc/passwd' }, 'x'), 'plugins/x');
});

test('a plugin hosted in another repo fails with a clear message', () => {
  assert.throws(
    () => sourcePathFor({ source: { source: 'github', repo: 'other/repo' } }, 'x'),
    (err) => err instanceof UserError && /another repository/.test(err.message),
  );
});

test('a 403 from GitHub suggests a token', async () => {
  await assert.rejects(
    loadCatalog({ repo: REPO, ref: 'main', deps: deps({ [CLAUDE_REG]: { status: 403 } }) }),
    (err) => err instanceof UserError && /GITHUB_TOKEN/.test(err.hint),
  );
});

test('a token in the environment is sent as a bearer header', () => {
  assert.equal(ghHeaders({ GITHUB_TOKEN: 'abc' }).Authorization, 'Bearer abc');
  assert.equal(ghHeaders({}).Authorization, undefined);
  assert.equal(ghHeaders({})['User-Agent'], 'context-plugins-installer');
});

test('registry entries that cannot name a plugin are dropped on load', async () => {
  const catalog = await loadCatalog({
    repo: REPO,
    ref: 'main',
    deps: deps({
      [CLAUDE_REG]: {
        body: {
          name: 'apimatic',
          plugins: [null, 42, { description: 'nameless' }, 'bare-id', { name: 'named-sdk' }],
        },
      },
    }),
  });
  assert.deepEqual(catalog.plugins, ['bare-id', { name: 'named-sdk' }]);
});
