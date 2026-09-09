import test from 'node:test';
import assert from 'node:assert';

import {
  getJson,
  ghHeaders,
  rawUrl,
  readRegistry,
} from '../../src/infrastructure/github-registry-client.js';
import type { FetchResponseLike, HttpPorts } from '../../src/types/ports.js';
import type { MarketplaceEvent } from '../../src/types/session.js';
import { portsFor, stubFetch, type StubRoute } from '../helpers.js';

const REPO = 'context-plugins/plugin-marketplace';
const CLAUDE_REG = rawUrl(REPO, 'main', '.claude-plugin/marketplace.json');
const CURSOR_REG = rawUrl(REPO, 'main', '.cursor-plugin/marketplace.json');

const registry = (over: Record<string, unknown> = {}) => ({
  name: 'apimatic',
  plugins: [{ name: 'my-sdk' }],
  ...over,
});

const ports = (routes: Record<string, StubRoute>): HttpPorts => portsFor(stubFetch(routes));

const recorder = () => {
  const events: MarketplaceEvent[] = [];
  return { events, notify: (e: MarketplaceEvent) => events.push(e) };
};

const read = (routes: Record<string, StubRoute>, notify?: (e: MarketplaceEvent) => void) =>
  readRegistry({ repo: REPO, ref: 'main', notify }, ports(routes));

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

/**
 * A 5xx is the far end failing, and the response is not the user's to read. A
 * real one from GitHub's raw CDN is an HTML Varnish page whose status line says
 * "Backend.max_conn reached" - repeating any of that reads as though the
 * marketplace, the token or the network were at fault, when the only useful
 * answer is "wait". So the sentence is ours, and the only thing kept from the
 * response is the code.
 */
test('a 5xx says the far end is down, and repeats nothing the far end said', async () => {
  const shouted = 'Backend.max_conn reached';
  const page = `<html><body><h1>Error 503 ${shouted}</h1><p>Varnish cache server</p></body></html>`;
  const fetchImpl = async (): Promise<FetchResponseLike> => ({
    ok: false,
    status: 503,
    statusText: shouted,
    text: async () => page,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));

  assert.equal(result.ok, false);
  const { message, hint } = result.ok ? { message: '', hint: '' } : result.error;
  assert.match(message, /raw\.githubusercontent\.com is temporarily unavailable \(HTTP 503\)/);
  assert.match(hint ?? '', /outage at GitHub, not a problem with your marketplace/);
  // The three things a generic message exists to keep out.
  assert.ok(!message.includes(shouted) && !(hint ?? '').includes(shouted), 'no status text');
  assert.ok(!message.includes('Varnish') && !message.includes('<html>'), 'no response body');
  assert.ok(!message.includes('marketplace.json'), 'no URL path');
});

/**
 * And the control: a 4xx is still reported exactly, because those are the ones
 * a user can do something about - a 403 is a token, a 401 is a bad one.
 */
test('a 4xx still names the request, so an actionable failure stays actionable', async () => {
  const result = await read({ [CLAUDE_REG]: { status: 401 } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /returned 401/);
  assert.match(result.ok ? '' : result.error.message, /marketplace\.json/);
});

test('an unusable repo fails before anything is fetched', async () => {
  const result = await readRegistry({ repo: 'not a repo', ref: 'main' }, ports({}));
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

/**
 * A body that dies mid-read was the one way out of this function that was still
 * a throw: the request was guarded and the `res.text()` after it was not, so a
 * connection reset during the body escaped as a raw Error while every other
 * network problem came back as a Failure.
 */
test('a body that dies mid-read is a failure like any other network problem', async () => {
  const fetchImpl = async (): Promise<FetchResponseLike> => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error('ECONNRESET');
    },
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));
  assert.equal(result.ok, false);
  assert.match(
    result.ok ? '' : result.error.message,
    /Could not reach raw\.githubusercontent\.com/,
  );
  assert.match(result.ok ? '' : (result.error.hint ?? ''), /network connection/);
});

test('a url too malformed to parse still reports the failure it hit', async () => {
  const fetchImpl = async (): Promise<FetchResponseLike> => {
    throw new Error('Invalid URL');
  };
  const result = await getJson('not://a real url', portsFor(fetchImpl));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /Invalid URL/);
});

test('a body that is not JSON at all names the file it came from', async () => {
  const result = await read({ [CLAUDE_REG]: { body: 'not json' } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /is not valid JSON/);
});
