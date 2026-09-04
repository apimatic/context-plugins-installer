import test from 'node:test';
import assert from 'node:assert';

import { resolvePlugin, loadCatalog, sourcePathFor } from '../src/catalog.js';
import { rawUrl } from '../src/infrastructure/github-registry-client.js';
import type { Deps } from '../src/types/ports.js';
import { UserError } from '../src/util.js';
import { stubFetch, type StubRoute } from './helpers.js';

const REPO = 'context-plugins/plugin-marketplace';
const CLAUDE_REG = rawUrl(REPO, 'main', '.claude-plugin/marketplace.json');

const registry = (over: Record<string, unknown> = {}) => ({
  name: 'apimatic',
  plugins: [
    { name: 'my-sdk', source: './plugins/my-sdk', description: 'A test SDK plugin' },
    { name: 'other-sdk', source: './plugins/other-sdk' },
  ],
  ...over,
});

const deps = (routes: Record<string, StubRoute>): Deps => ({
  fetchImpl: stubFetch(routes),
  env: {},
});

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
      /kebab-case/.test(err.hint ?? ''),
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
      /Did you mean: my-sdk/.test(err.hint ?? ''),
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
    (err) => err instanceof UserError && /Run 'list' to see the 2 available/.test(err.hint ?? ''),
  );
});

test('no registry at all asks for --marketplace instead of guessing', async () => {
  await assert.rejects(
    resolvePlugin({ repo: REPO, ref: 'main', plugin: 'my-sdk', deps: deps({}) }),
    (err) => err instanceof UserError && /--marketplace/.test(err.hint ?? ''),
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
  assert.equal(sourcePathFor({ name: 'x', source: './plugins/x' }, 'x'), 'plugins/x');
  assert.equal(sourcePathFor({ name: 'x', source: 'plugins/x/' }, 'x'), 'plugins/x');
  assert.equal(sourcePathFor({ name: 'x', source: '/plugins/x' }, 'x'), 'plugins/x');
  assert.equal(sourcePathFor(undefined, 'x'), 'plugins/x');
  assert.equal(sourcePathFor('x', 'x'), 'plugins/x');
});

test('a traversal attempt in source is ignored', () => {
  assert.equal(sourcePathFor({ name: 'x', source: '../../etc/passwd' }, 'x'), 'plugins/x');
});

test('a plugin hosted in another repo fails with a clear message', () => {
  assert.throws(
    () => sourcePathFor({ name: 'x', source: { source: 'github', repo: 'other/repo' } }, 'x'),
    (err) => err instanceof UserError && /another repository/.test(err.message),
  );
});

// The registry client returns a Failure now; this is the bridge that turns it
// back into the throw every caller of loadCatalog still expects, message and
// hint intact. It goes when the last caller takes the Result itself.
test('a failure from the registry client reaches callers as a UserError', async () => {
  await assert.rejects(
    loadCatalog({ repo: REPO, ref: 'main', deps: deps({ [CLAUDE_REG]: { status: 403 } }) }),
    (err) => err instanceof UserError && /GITHUB_TOKEN/.test(err.hint ?? ''),
  );
});

test('a typo still fails early when every declared entry was unusable', async () => {
  await assert.rejects(
    resolvePlugin({
      repo: REPO,
      ref: 'main',
      plugin: 'my-sdkk',
      deps: deps({
        [CLAUDE_REG]: { body: { name: 'acme', plugins: [{ id: 'my-sdk' }] } },
      }),
    }),
    (err) =>
      err instanceof UserError &&
      /not listed/.test(err.message) &&
      /none has a usable/.test(err.hint ?? ''),
  );
});

test('a non-string description is coerced, keeping the string contract', async () => {
  const resolved = await resolvePlugin({
    repo: REPO,
    ref: 'main',
    plugin: 'my-sdk',
    deps: deps({
      [CLAUDE_REG]: { body: { name: 'acme', plugins: [{ name: 'my-sdk', description: 42 }] } },
    }),
  });
  assert.equal(resolved.description, '');
});

test('an array source is refused, not read as plugins/<id>', () => {
  assert.throws(
    () => sourcePathFor({ name: 'x', source: ['other/repo'] }, 'x'),
    (err) => err instanceof UserError && /another repository/.test(err.message),
  );
});
