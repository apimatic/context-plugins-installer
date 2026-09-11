import test from 'node:test';
import assert from 'node:assert';

import {
  RAW_MEDIA_TYPE,
  ghHeaders,
  hostOf,
  isUpstreamOutage,
  rawUrl,
  readPluginManifest,
  readRegistry,
} from '../../src/infrastructure/github-registry-client.js';
import { RepoSlug } from '../../src/types/ids/repo-slug.js';
import type { FetchLike, FetchResponseLike, HttpPorts } from '../../src/types/ports.js';
import type { MarketplaceEvent } from '../../src/types/session.js';
import { portsFor, stubFetch, type StubRoute } from '../helpers.js';

const REPO = 'context-plugins/plugin-marketplace';
const CLAUDE_FILE = '.claude-plugin/marketplace.json';
const CLAUDE_REG = rawUrl(REPO, 'main', CLAUDE_FILE);
const CURSOR_REG = rawUrl(REPO, 'main', '.cursor-plugin/marketplace.json');
/** The same file at the other host, which is where a raw outage sends the read. */
const CLAUDE_API = new RepoSlug(REPO).contentsUrl('main', CLAUDE_FILE);

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
  assert.match(hint ?? '', /Usually an outage at GitHub rather than a problem with your setup/);
  // The three things a generic message exists to keep out.
  assert.ok(!message.includes(shouted) && !(hint ?? '').includes(shouted), 'no status text');
  assert.ok(!message.includes('Varnish') && !message.includes('<html>'), 'no response body');
  assert.ok(!message.includes('marketplace.json'), 'no URL path');
});

/**
 * And the control: a 4xx is still reported exactly, because those are the ones
 * a user can do something about - a 403 is a token, a 401 is a bad one.
 */
/**
 * The boundary as a value, because every site-level test below picks one status
 * on each side and none of them pins where the line is: `>= 500` widened to
 * `> 500` sends a plain HTTP 500 - the one GitHub emits most - back down the
 * verbatim path at all three call sites with the suite green.
 */
test('the outage boundary is 500, and every 4xx is on the other side of it', () => {
  for (const status of [500, 501, 502, 503, 504, 599]) {
    assert.equal(isUpstreamOutage(status), true, `${status} is the far end failing`);
  }
  for (const status of [200, 400, 401, 403, 404, 429, 499]) {
    assert.equal(isUpstreamOutage(status), false, `${status} is not an outage`);
  }
});

test('a 4xx still names the request, so an actionable failure stays actionable', async () => {
  const result = await read({ [CLAUDE_REG]: { status: 401 } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /returned 401/);
  assert.match(result.ok ? '' : result.error.message, /marketplace\.json/);
});

/**
 * The reason this fallback exists: `raw.githubusercontent.com` serves a 503 of
 * its own often enough to be the most common way an install fails for no
 * reason. The API's contents endpoint is a different service serving the same
 * bytes, so the read gets its answer and the run carries on.
 */
test('a 503 from the raw CDN is retried at the GitHub API, which answers', async () => {
  const fetchImpl = stubFetch({
    [CLAUDE_REG]: { status: 503 },
    [CLAUDE_API]: { body: registry({ name: 'served-by-the-api' }) },
  });
  const seen = recorder();

  const result = await readRegistry(
    { repo: REPO, ref: 'main', notify: seen.notify },
    portsFor(fetchImpl),
  );

  assert.ok(result.ok);
  assert.equal(result.value?.marketplace, 'served-by-the-api');
  assert.equal(result.value?.from, CLAUDE_FILE, 'the file it names is the one it asked for');
  assert.deepEqual(fetchImpl.calls, [CLAUDE_REG, CLAUDE_API]);
  // Before the retry, not after it: the line is what explains the second wait.
  assert.deepEqual(seen.events, [
    { kind: 'raw-outage', host: 'raw.githubusercontent.com', status: 503 },
  ]);
});

/**
 * The API answers that endpoint with a JSON envelope carrying base64 unless it
 * is asked for the file itself, so this header is the difference between the
 * fallback returning the registry and returning a wrapper around it. A token
 * still rides along when the environment has one - unauthenticated works, at 60
 * requests an hour.
 */
test('the fallback asks for the file itself, with a token when there is one', async () => {
  const asked: [url: string, accept: string | undefined, auth: string | undefined][] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    asked.push([url, init?.headers?.Accept, init?.headers?.Authorization]);
    const outage = url === CLAUDE_REG;
    const body = outage ? '' : JSON.stringify(registry());
    return {
      ok: !outage,
      status: outage ? 503 : 200,
      text: async () => body,
      json: async (): Promise<unknown> => JSON.parse(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  const result = await readRegistry(
    { repo: REPO, ref: 'main' },
    portsFor(fetchImpl, { GITHUB_TOKEN: 'sekret' }),
  );

  assert.ok(result.ok);
  assert.deepEqual(asked, [
    [CLAUDE_REG, 'application/json', 'Bearer sekret'],
    [CLAUDE_API, RAW_MEDIA_TYPE, 'Bearer sekret'],
  ]);
});

/**
 * And the other side of that boundary, which is why the fallback reads
 * `isUpstreamOutage` rather than `!res.ok`: a 404 is the answer to the question
 * this read asks twice - "is the registry in this folder?" - and a 403 is a
 * rate limit the second host cannot improve on. Asking anyway would spend the
 * API budget on both, and let the second answer replace a message the user can
 * act on.
 */
test('a 404 and a 403 are answers rather than outages, so neither asks the API', async () => {
  const absent = stubFetch({});
  const missing = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(absent));
  assert.ok(missing.ok);
  assert.equal(missing.value, null);
  assert.deepEqual(absent.calls, [CLAUDE_REG, CURSOR_REG], 'one request per registry file');

  const denied = stubFetch({ [CLAUDE_REG]: { status: 403 } });
  const refused = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(denied));
  assert.equal(refused.ok, false);
  assert.deepEqual(denied.calls, [CLAUDE_REG]);
});

/**
 * When the fallback fails too it has recovered nothing, and the outage is the
 * better of the two diagnoses: the API's own status is about a host we only
 * asked because the first one was down. A 404 from it is the case that matters
 * - reading that as "this repo has no registry" would send the user off to
 * check their --repo in the middle of a GitHub outage.
 */
test('a raw outage the API cannot answer either stays an outage, not a missing registry', async () => {
  const fetchImpl = stubFetch({ [CLAUDE_REG]: { status: 503 } }); // the API 404s
  const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));

  assert.equal(result.ok, false);
  const message = result.ok ? '' : result.error.message;
  assert.equal(message, 'raw.githubusercontent.com is temporarily unavailable (HTTP 503).');
  assert.deepEqual(fetchImpl.calls, [CLAUDE_REG, CLAUDE_API]);
});

test('an API that is down as well is reported as the outage the CDN reported', async () => {
  const fetchImpl = stubFetch({ [CLAUDE_REG]: { status: 503 }, [CLAUDE_API]: { status: 500 } });
  const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));

  assert.equal(result.ok, false);
  const message = result.ok ? '' : result.error.message;
  assert.match(message, /raw\.githubusercontent\.com is temporarily unavailable \(HTTP 503\)/);
  assert.ok(!message.includes('api.github.com'), 'the host named is the one that failed first');
});

/** A request that never arrives is the network, not a busy CDN: a second host doubles the wait for nothing. */
test('a request that throws is not retried at the other host', async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));

  assert.equal(result.ok, false);
  assert.match(
    result.ok ? '' : result.error.message,
    /Could not reach raw\.githubusercontent\.com/,
  );
  assert.deepEqual(calls, [CLAUDE_REG]);
});

/**
 * The one thing the fallback must never do. Asked with anything but
 * `RAW_MEDIA_TYPE`, the contents endpoint answers 200 with an envelope
 * *about* the file - and its `name` is the file's own name, so `normalize`
 * reads it as a marketplace called `marketplace.json` holding no plugins, and
 * a plugin file would be overwritten with the envelope byte for byte. A proxy
 * that rewrites `Accept` is how one arrives, so the header is checked rather
 * than trusted, and "try again in a moment" is the answer.
 */
test('an envelope about the file is not the file, and does not pass for one', async () => {
  const envelope = {
    name: 'marketplace.json',
    path: CLAUDE_FILE,
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(registry())).toString('base64'),
  };
  const fetchImpl: FetchLike = async (url) => {
    const outage = url === CLAUDE_REG;
    const body = JSON.stringify(envelope);
    return {
      ok: !outage,
      status: outage ? 503 : 200,
      // What that endpoint answers when it is not asked for the raw file.
      headers: {
        get: (name) => (/^content-type$/i.test(name) ? 'application/json; charset=utf-8' : null),
      },
      text: async () => body,
      json: async (): Promise<unknown> => JSON.parse(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));

  assert.equal(result.ok, false, 'an envelope must not read as a registry');
  assert.equal(
    result.ok ? '' : result.error.message,
    'raw.githubusercontent.com is temporarily unavailable (HTTP 503).',
  );
});

/**
 * And the controls, which are what make the check above a check on the envelope
 * rather than on the word "json". `application/vnd.github.raw+json` is GitHub's
 * own current spelling of the *raw* media type, so a content-type test written
 * as a search for "json" refuses the file it just asked for - and a stub, or any
 * response this program cannot ask, has to count as the file rather than
 * disable the fallback.
 */
for (const [what, headers] of [
  ['the raw media type', { get: () => 'application/vnd.github.raw; charset=utf-8' }],
  ['the +json spelling of it', { get: () => 'application/vnd.github.raw+json; charset=utf-8' }],
  ['no headers to ask at all', undefined],
] as [string, { get(name: string): string | null } | undefined][]) {
  test(`a fallback answering with ${what} is the file, and is used`, async () => {
    const fetchImpl: FetchLike = async (url) => {
      const outage = url === CLAUDE_REG;
      const body = JSON.stringify(registry({ name: 'served-raw' }));
      return {
        ok: !outage,
        status: outage ? 503 : 200,
        headers,
        text: async () => body,
        json: async (): Promise<unknown> => JSON.parse(body),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const result = await readRegistry({ repo: REPO, ref: 'main' }, portsFor(fetchImpl));

    assert.ok(result.ok);
    assert.equal(result.value?.marketplace, 'served-raw');
  });
}

/**
 * The order, which the events alone do not pin: the line exists to explain the
 * second request, so it has to be said before that request is made and not
 * after it comes back. Moving the `notify` below the fetch leaves every other
 * assertion in this file green.
 */
test('the retry is announced before the request it explains, not after', async () => {
  const happened: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    happened.push(`fetch ${url === CLAUDE_REG ? 'raw' : 'api'}`);
    const outage = url === CLAUDE_REG;
    const body = outage ? '' : JSON.stringify(registry());
    return {
      ok: !outage,
      status: outage ? 503 : 200,
      text: async () => body,
      json: async (): Promise<unknown> => JSON.parse(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  const result = await readRegistry(
    { repo: REPO, ref: 'main', notify: (e) => happened.push(`say ${e.kind}`) },
    portsFor(fetchImpl),
  );

  assert.ok(result.ok);
  assert.deepEqual(happened, ['fetch raw', 'say raw-outage', 'fetch api']);
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

/**
 * The guard that test used to reach through `getJson`, now that every URL this
 * module fetches is built from a validated slug: `hostOf` is called from inside
 * the handler for a failed request, so a string it cannot parse has to come
 * back as itself rather than throwing a TypeError over the original error.
 */
test('a host that cannot be parsed out of a url is the url, not a throw', () => {
  assert.equal(hostOf('https://raw.githubusercontent.com/a/b'), 'raw.githubusercontent.com');
  assert.equal(hostOf('not://a real url'), 'not://a real url');
});

test('a body that is not JSON at all names the file it came from', async () => {
  const result = await read({ [CLAUDE_REG]: { body: 'not json' } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /is not valid JSON/);
});

// A repository that is itself a plugin, read over the same two hosts. The probe
// order is the manifest type's; what is asserted here is which files are asked
// for, in which folder, and which of the ways it can go wrong is reported.

const CLAUDE_MANIFEST = '.claude-plugin/plugin.json';

const manifest = (routes: Record<string, StubRoute>, path: string | null = null) =>
  readPluginManifest({ repo: REPO, ref: 'main', path }, ports(routes));

test('a repository that declares a plugin is read as that plugin', async () => {
  const result = await manifest({
    [rawUrl(REPO, 'main', CLAUDE_MANIFEST)]: {
      body: { name: 'whole-repo', description: 'the repo is the plugin' },
    },
  });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.id.toString(), 'whole-repo');
  assert.equal(result.value.description, 'the repo is the plugin');
});

test('a folder inside a repository is read from that folder', async () => {
  const fetchImpl = stubFetch({
    [rawUrl(REPO, 'main', `tools/foo/${CLAUDE_MANIFEST}`)]: { body: { name: 'foo' } },
  });
  const result = await readPluginManifest(
    { repo: REPO, ref: 'main', path: 'tools/foo' },
    portsFor(fetchImpl),
  );
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.id.toString(), 'foo');
  // The repository root is never read for a folder install: a monorepo's own
  // top-level manifest is not the plugin that was asked for.
  assert.ok(!fetchImpl.calls.includes(rawUrl(REPO, 'main', CLAUDE_MANIFEST)));
});

test('the other two manifest locations are tried, in order', async () => {
  const cursor = await manifest({
    [rawUrl(REPO, 'main', '.cursor-plugin/plugin.json')]: { body: { name: 'cursor-shaped' } },
  });
  assert.ok(cursor.ok && cursor.value.id.toString() === 'cursor-shaped');

  const bare = await manifest({
    [rawUrl(REPO, 'main', 'plugin.json')]: { body: { name: 'bare' } },
  });
  assert.ok(bare.ok && bare.value.id.toString() === 'bare');
});

test('a manifest that is there but unusable is the answer, not a missing one', async () => {
  // The failure this avoids: "does not look like a plugin" about a repository
  // whose plugin.json is sitting right there with a name this build refuses.
  const result = await manifest({
    [rawUrl(REPO, 'main', CLAUDE_MANIFEST)]: { body: { name: 'Not An Id' } },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /which is not a usable plugin id/);
    assert.match(result.error.message, new RegExp(CLAUDE_MANIFEST.replace('.', '\\.')));
  }
});

test('a repository that is a marketplace says so, rather than only what is missing', async () => {
  // Pointing at a marketplace and spelling it as a plugin is the one wrong
  // turn where the repository really is installable - through --repo.
  const result = await manifest({
    [rawUrl(REPO, 'main', CLAUDE_FILE)]: { body: registry() },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /is a marketplace/);
    assert.match(result.error.hint ?? '', /--repo context-plugins\/plugin-marketplace/);
  }
});

test('a repository with nothing in it names the three files it looked for', async () => {
  const result = await manifest({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /does not look like a plugin/);
    assert.match(result.error.hint ?? '', /\.claude-plugin\/plugin\.json/);
    assert.match(result.error.hint ?? '', /\.cursor-plugin\/plugin\.json/);
  }
});

test('the marketplace probe only runs once nothing else worked', async () => {
  const fetchImpl = stubFetch({
    [rawUrl(REPO, 'main', CLAUDE_MANIFEST)]: { body: { name: 'whole-repo' } },
  });
  const result = await readPluginManifest(
    { repo: REPO, ref: 'main', path: null },
    portsFor(fetchImpl),
  );
  assert.ok(result.ok);
  assert.deepEqual(fetchImpl.calls, [rawUrl(REPO, 'main', CLAUDE_MANIFEST)], 'one request');
});

test('a manifest the raw CDN cannot serve comes from the API instead', async () => {
  // The fallback is inherited rather than re-implemented, which is the reason
  // this read lives beside the registry read at all.
  const api = new RepoSlug(REPO).contentsUrl('main', CLAUDE_MANIFEST);
  const result = await manifest({
    [rawUrl(REPO, 'main', CLAUDE_MANIFEST)]: { status: 503 },
    [api]: { body: { name: 'whole-repo' } },
  });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.id.toString(), 'whole-repo');
});

test('a repo or ref this build cannot pass on is refused before any request', async () => {
  const fetchImpl = stubFetch({});
  const bad = await readPluginManifest(
    { repo: 'not a repo', ref: 'main', path: null },
    portsFor(fetchImpl),
  );
  assert.equal(bad.ok, false);
  const worse = await readPluginManifest(
    { repo: REPO, ref: '--upload-pack=evil', path: null },
    portsFor(fetchImpl),
  );
  assert.equal(worse.ok, false);
  assert.deepEqual(fetchImpl.calls, []);
});
