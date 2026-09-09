import test from 'node:test';
import assert from 'node:assert';

import { services } from '../../src/composition/index.js';
import { rawUrl } from '../../src/infrastructure/github-registry-client.js';
import { DoctorPrompts } from '../../src/prompts/doctor.js';
import { ListPrompts } from '../../src/prompts/list.js';
import { announceMarketplace } from '../../src/prompts/marketplace.js';
import { RouterPrompts } from '../../src/prompts/router.js';
import { log } from '../../src/prompts/terminal.js';
import { UninstallPrompts } from '../../src/prompts/uninstall.js';
import type { FetchLike } from '../../src/types/ports.js';
import type { MarketplaceEvent, MarketplaceListener } from '../../src/types/session.js';
import { portsFor, stubFetch } from '../helpers.js';

// The other half of "infrastructure reports and a prompts class speaks", for
// the marketplace events. `test/infrastructure/session.test.ts` asserts which
// events a run emits and how often; this asserts the words they become, and
// that the listener a command actually passes is the one that says them.
//
// Recorded at `log` rather than the console, like test/prompts/harness.test.ts:
// the message and its level belong here, the glyph and the wrapping to
// terminal.ts.

type Line = [level: 'ok' | 'info' | 'warn' | 'warnStderr' | 'debug', text: string];

const LEVELS = ['ok', 'info', 'warn', 'warnStderr', 'debug'] as const;

/** What one event says through `listener`, in order, as (level, message) pairs. */
function said(event: MarketplaceEvent, listener: MarketplaceListener): Line[] {
  const lines: Line[] = [];
  const real = LEVELS.map((level) => [level, log[level]] as const);
  for (const level of LEVELS) log[level] = (msg: string) => lines.push([level, msg]);
  try {
    listener(event);
  } finally {
    for (const [level, fn] of real) log[level] = fn;
  }
  return lines;
}

/**
 * Keyed by kind rather than a list, so an event added to `MarketplaceEvent`
 * without a row here fails to compile - the same guarantee the `never` default
 * in `announceMarketplace` gives the renderer itself.
 */
const CASES: Record<MarketplaceEvent['kind'], [MarketplaceEvent, Line[]]> = {
  'registry-skipped': [
    { kind: 'registry-skipped', file: '.claude-plugin/marketplace.json', repo: 'acme/m' },
    [['debug', '.claude-plugin/marketplace.json in acme/m is not a JSON object - skipping it.']],
  ],
  // The other warning that explains a slow path before it happens - and the
  // one that has to reach stderr, because a registry read is what `list --json`
  // does and this line would otherwise land in the payload.
  'raw-outage': [
    { kind: 'raw-outage', host: 'raw.githubusercontent.com', status: 503 },
    [
      [
        'warnStderr',
        'raw.githubusercontent.com is unavailable (HTTP 503) - retrying through the GitHub API.',
      ],
    ],
  ],
  // A warning that explains the slow path, which is why it is emitted before
  // the fallback rather than reported from its result.
  'no-git': [
    { kind: 'no-git' },
    [
      [
        'warn',
        'git not found - falling back to the GitHub API (60 requests/hour unauthenticated).',
      ],
    ],
  ],
  cloning: [
    { kind: 'cloning', url: 'https://github.com/acme/m.git', ref: 'main' },
    [
      ['info', 'Fetching marketplace via git ...'],
      ['debug', 'https://github.com/acme/m.git (main)'],
    ],
  ],
  'checked-out': [{ kind: 'checked-out', files: 12 }, [['debug', '12 files checked out']]],
  'tree-truncated': [
    { kind: 'tree-truncated' },
    [['warn', 'GitHub tree response was truncated; some files may be missing. Prefer git.']],
  ],
  downloaded: [
    { kind: 'downloaded', files: 7 },
    [['info', 'Downloaded 7 files via the GitHub API.']],
  ],
};

for (const [kind, [event, expected]] of Object.entries(CASES)) {
  test(`a ${kind} event says its line`, () => {
    assert.deepEqual(said(event, announceMarketplace), expected);
  });
}

/**
 * The wiring, which is the part a refactor can silently drop. Every one of
 * these classes hands its listener to something that reads a marketplace - the
 * router to the session that `install` and `update` share, `list` and `doctor`
 * to `readRegistry`, `uninstall` to the name lookup - so a member that stopped
 * being the renderer would take that command's progress lines with it and
 * every other assertion in the suite would still pass.
 */
test('every prompts class that owns a marketplace call says the lines', () => {
  const owners: [string, MarketplaceListener][] = [
    ['router', new RouterPrompts().marketplaceListener],
    ['list', new ListPrompts().marketplaceListener],
    ['doctor', new DoctorPrompts().marketplaceListener],
    ['uninstall', new UninstallPrompts().marketplaceListener],
  ];
  for (const [owner, listener] of owners) {
    assert.deepEqual(
      said({ kind: 'no-git' }, listener),
      CASES['no-git'][1],
      `${owner} does not say the marketplace lines`,
    );
  }
});

/**
 * And the other end of that wire: the composition root builds the session but
 * takes the listener from its caller, so dropping `notify` on the way through
 * would silence a real run while every session test - which calls
 * `createSession` directly - stayed green.
 */
/**
 * And that the ports reach the *fetcher*, not only the registry client. The
 * test above passes with a fetcher built over a blank environment, because a
 * registry read does not need the token - so this one asserts the header the
 * env is for, through the clone path's own request.
 */
test('the composition root gives both clients the ports it was handed', async () => {
  const headers: Record<string, string>[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    headers.push({ ...(init?.headers ?? {}) });
    return {
      ok: false,
      status: 500,
      statusText: 'stop here',
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  // No git on this PATH, so `openRepo` takes the API route and asks for a tree.
  const session = services().session(() => {}, {
    fetch: fetchImpl,
    env: { PATH: '', GITHUB_TOKEN: 'sekret' },
    runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }), which: () => null },
  });
  try {
    await session.source({ repo: 'acme/m', ref: 'main', sourcePath: 'plugins/alpha' });
  } finally {
    await session.cleanup();
  }
  assert.equal(headers.length, 1, 'the API route made its one request');
  assert.equal(
    headers[0].Authorization,
    'Bearer sekret',
    'the fetcher read the env it was built with, not the host one',
  );
});

test('the composition root hands the session the listener it was given', async () => {
  const repo = 'acme/plugin-marketplace';
  const fetchImpl = stubFetch({
    [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: { body: ['not', 'an', 'object'] },
    [rawUrl(repo, 'main', '.cursor-plugin/marketplace.json')]: {
      body: { name: 'acme', plugins: [{ name: 'alpha' }] },
    },
  });
  const seen: MarketplaceEvent[] = [];
  const session = services().session((event) => seen.push(event), portsFor(fetchImpl));
  try {
    const read = await session.catalog({ repo, ref: 'main' });
    assert.ok(read.ok);
  } finally {
    await session.cleanup();
  }
  assert.deepEqual(seen, [
    { kind: 'registry-skipped', file: '.claude-plugin/marketplace.json', repo },
  ]);
});
