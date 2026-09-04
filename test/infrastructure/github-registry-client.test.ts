import test from 'node:test';
import assert from 'node:assert';

import {
  ghHeaders,
  rawUrl,
  readRegistry,
} from '../../src/infrastructure/github-registry-client.js';
import type { Deps } from '../../src/types/ports.js';
import type { MarketplaceEvent } from '../../src/types/session.js';
import { stubFetch, type StubRoute } from '../helpers.js';

const REPO = 'context-plugins/plugin-marketplace';
const CLAUDE_REG = rawUrl(REPO, 'main', '.claude-plugin/marketplace.json');
const CURSOR_REG = rawUrl(REPO, 'main', '.cursor-plugin/marketplace.json');

const registry = (over: Record<string, unknown> = {}) => ({
  name: 'apimatic',
  plugins: [{ name: 'my-sdk' }],
  ...over,
});

const deps = (routes: Record<string, StubRoute>): Deps => ({
  fetchImpl: stubFetch(routes),
  env: {},
});

const recorder = () => {
  const events: MarketplaceEvent[] = [];
  return { events, notify: (e: MarketplaceEvent) => events.push(e) };
};

const read = (routes: Record<string, StubRoute>, notify?: (e: MarketplaceEvent) => void) =>
  readRegistry({ repo: REPO, ref: 'main', deps: deps(routes), notify });

test('a repo with no registry at all reads as a successful null', async () => {
  const result = await read({});
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, null);
});

test('the Cursor registry is used when the Claude one is absent', async () => {
  const result = await read({ [CURSOR_REG]: { body: registry({ name: 'cursor-brand' }) } });
  assert.ok(result.ok);
  assert.equal(result.value?.marketplace, 'cursor-brand');
  assert.equal(result.value?.from, '.cursor-plugin/marketplace.json');
});

// The client is the boundary that stopped throwing, so what a caller used to
// catch has to arrive as a value carrying the same words.
test('a 403 comes back as a failure suggesting a token, not as a throw', async () => {
  const result = await read({ [CLAUDE_REG]: { status: 403 } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : (result.error.hint ?? ''), /GITHUB_TOKEN/);
});

test('an unusable repo fails before anything is fetched', async () => {
  const result = await readRegistry({ repo: 'not a repo', ref: 'main', deps: deps({}) });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /Invalid repo/);
  assert.match(result.ok ? '' : (result.error.hint ?? ''), /owner\/repo/);
});

test('a token in the environment is sent as a bearer header', () => {
  assert.equal(ghHeaders({ GITHUB_TOKEN: 'abc' }).Authorization, 'Bearer abc');
  assert.equal(ghHeaders({}).Authorization, undefined);
  assert.equal(ghHeaders({})['User-Agent'], 'context-plugins-installer');
});

test('registry entries that cannot name a plugin are dropped on read', async () => {
  const result = await read({
    [CLAUDE_REG]: {
      body: {
        name: 'apimatic',
        plugins: [null, 42, { description: 'nameless' }, 'bare-id', { name: 'named-sdk' }],
      },
    },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value?.plugins, ['bare-id', { name: 'named-sdk' }]);
  assert.equal(result.value?.dropped, 3);
});

test('a wrong-shaped registry document falls through to the next file, and is named', async () => {
  const seen = recorder();
  const result = await read(
    {
      [CLAUDE_REG]: { body: ['my-sdk'] }, // a bare array, not a registry object
      [CURSOR_REG]: { body: registry({ name: 'acme' }) },
    },
    seen.notify,
  );
  assert.ok(result.ok);
  assert.equal(result.value?.from, '.cursor-plugin/marketplace.json');
  assert.deepEqual(seen.events, [
    { kind: 'registry-skipped', file: '.claude-plugin/marketplace.json', repo: REPO },
  ]);
});

/**
 * The line is said where the skip happens, not carried out on the result. The
 * old reader printed it as it went, so a file skipped before a later file failed
 * was still mentioned; anything reported only on the way out would have dropped
 * it here.
 */
test('a file skipped before a later failure is still reported', async () => {
  const seen = recorder();
  const result = await read(
    { [CLAUDE_REG]: { body: ['my-sdk'] }, [CURSOR_REG]: { status: 403 } },
    seen.notify,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(seen.events, [
    { kind: 'registry-skipped', file: '.claude-plugin/marketplace.json', repo: REPO },
  ]);
});

test('a registry that reads first time says nothing at all', async () => {
  const seen = recorder();
  const result = await read({ [CLAUDE_REG]: { body: registry() } }, seen.notify);
  assert.ok(result.ok);
  assert.deepEqual(seen.events, []);
});

test('a body that is not JSON at all names the file it came from', async () => {
  const result = await read({ [CLAUDE_REG]: { body: 'not json' } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /is not valid JSON/);
});
