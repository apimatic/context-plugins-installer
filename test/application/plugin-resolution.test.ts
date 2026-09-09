import test from 'node:test';
import assert from 'node:assert';

import { resolvePlugin, sourcePathFor, suggest } from '../../src/application/plugin-resolution.js';
import { normalize, REGISTRY_FILES, type Catalog } from '../../src/types/catalog.js';
import type { Failure } from '../../src/types/failure.js';
import type { ResolvedPlugin } from '../../src/types/catalog.js';
import type { Result } from '../../src/types/result.js';

// Pure now: the registry arrives already read, so these cases are the decision
// itself with no fetch anywhere near them. Reading the bytes is
// test/infrastructure/github-registry-client.test.ts.

const REPO = 'context-plugins/plugin-marketplace';

const catalogOf = (over: Record<string, unknown> = {}): Catalog =>
  normalize(
    {
      name: 'apimatic',
      plugins: [
        { name: 'my-sdk', source: './plugins/my-sdk', description: 'A test SDK plugin' },
        { name: 'other-sdk', source: './plugins/other-sdk' },
      ],
      ...over,
    },
    REGISTRY_FILES[0],
  );

const resolve = (
  catalog: Catalog | null,
  over: Record<string, unknown> = {},
): Result<ResolvedPlugin, Failure> =>
  resolvePlugin(catalog, { plugin: 'my-sdk', repo: REPO, ref: 'main', ...over });

const value = (result: Result<ResolvedPlugin, Failure>): ResolvedPlugin => {
  assert.ok(result.ok, `expected a resolved plugin, got: ${result.ok ? '' : result.error.message}`);
  return result.value;
};

const failure = (result: Result<ResolvedPlugin, Failure>): Failure => {
  assert.ok(!result.ok, 'expected a failure');
  return result.error;
};

test('the marketplace name is derived from the registry, not hardcoded', () => {
  assert.equal(value(resolve(catalogOf({ name: 'acme' }))).marketplace, 'acme');
});

test('an explicit marketplace overrides the registry value', () => {
  assert.equal(value(resolve(catalogOf(), { marketplace: 'override' })).marketplace, 'override');
});

test('the source path is normalized and the description carried through', () => {
  const resolved = value(resolve(catalogOf()));
  assert.equal(resolved.sourcePath, 'plugins/my-sdk');
  assert.equal(resolved.description, 'A test SDK plugin');
  assert.equal(resolved.catalogFound, true);
});

test('a marketplace name with spaces is rejected with the schema rule', () => {
  const err = failure(resolve(catalogOf({ name: 'Context Plugins' })));
  assert.match(err.message, /not a valid identifier/);
  assert.match(err.hint ?? '', /kebab-case/);
});

test('ordinary marketplace identifiers still pass', () => {
  for (const name of ['apimatic', 'context-plugins', 'acme_2', 'a.b']) {
    assert.equal(value(resolve(catalogOf({ name }))).marketplace, name);
  }
});

test('a mistyped plugin name suggests the closest match', () => {
  const err = failure(resolve(catalogOf(), { plugin: 'my-sdkk' }));
  assert.match(err.message, /not listed/);
  assert.match(err.hint ?? '', /Did you mean: my-sdk/);
});

test('a plugin with no near match points at the list command and the count', () => {
  const err = failure(resolve(catalogOf(), { plugin: 'zzzzzzzzzzzzzzzz' }));
  assert.match(err.hint ?? '', /Run 'list' to see the 2 available/);
});

test('no registry at all asks for --marketplace instead of guessing', () => {
  assert.match(failure(resolve(null)).hint ?? '', /--marketplace/);
});

test('no registry plus an explicit marketplace falls back to plugins/<id>', () => {
  const resolved = value(resolve(null, { marketplace: 'acme' }));
  assert.equal(resolved.sourcePath, 'plugins/my-sdk');
  assert.equal(resolved.catalogFound, false);
});

test('a typo still fails early when every declared entry was unusable', () => {
  const catalog = normalize({ name: 'acme', plugins: [{ id: 'my-sdk' }] }, REGISTRY_FILES[0]);
  const err = failure(resolve(catalog, { plugin: 'my-sdkk' }));
  assert.match(err.message, /not listed/);
  assert.match(err.hint ?? '', /none has a usable/);
});

test('a non-string description is coerced, keeping the string contract', () => {
  const catalog = normalize(
    { name: 'acme', plugins: [{ name: 'my-sdk', description: 42 }] },
    REGISTRY_FILES[0],
  );
  assert.equal(value(resolve(catalog)).description, '');
});

// The label is what the user asked for; the repo@ref is only the fallback, so a
// custom marketplace name never leaks the built-in repository into the message.
test('the failure names what the user called the marketplace', () => {
  assert.match(
    failure(resolve(catalogOf(), { plugin: 'nope', label: 'Acme Marketplace' })).message,
    /not listed in Acme Marketplace/,
  );
  assert.match(
    failure(resolve(catalogOf(), { plugin: 'nope' })).message,
    new RegExp(`not listed in ${REPO}@main`),
  );
});

const path = (entry: unknown, plugin = 'x'): Result<string, Failure> =>
  sourcePathFor(entry as never, plugin);

test('sourcePathFor normalizes the shapes a registry can use', () => {
  assert.deepEqual(path({ name: 'x', source: './plugins/x' }), { ok: true, value: 'plugins/x' });
  assert.deepEqual(path({ name: 'x', source: 'plugins/x/' }), { ok: true, value: 'plugins/x' });
  assert.deepEqual(path({ name: 'x', source: '/plugins/x' }), { ok: true, value: 'plugins/x' });
  assert.deepEqual(path(undefined), { ok: true, value: 'plugins/x' });
  assert.deepEqual(path('x'), { ok: true, value: 'plugins/x' });
});

test('a traversal attempt in source is ignored', () => {
  assert.deepEqual(path({ name: 'x', source: '../../etc/passwd' }), {
    ok: true,
    value: 'plugins/x',
  });
});

test('a plugin hosted in another repo fails with a clear message', () => {
  const result = path({ name: 'x', source: { source: 'github', repo: 'other/repo' } });
  assert.ok(!result.ok);
  assert.match(result.error.message, /another repository/);
});

test('an array source is refused, not read as plugins/<id>', () => {
  const result = path({ name: 'x', source: ['other/repo'] });
  assert.ok(!result.ok);
  assert.match(result.error.message, /another repository/);
});

test('suggest finds a near miss even when a shared suffix inflates the distance', () => {
  const names = ['azure-cognitive-sdk', 'docker-sdk', 'vimeo-sdk'];
  assert.deepEqual(suggest('azure-cognitve', names), ['azure-cognitive-sdk']);
  assert.deepEqual(suggest('docker', names), ['docker-sdk']);
  assert.deepEqual(suggest('zzzzzzzzzzzzzzzz', names), []);
});
