import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';

import { rawUrl, registryClient } from '../../src/infrastructure/github-registry-client.js';
import { sourceFetcher } from '../../src/infrastructure/source-fetcher.js';
import { ClaudeHarness } from '../../src/harnesses/claude.js';
import { MarketplaceName } from '../../src/types/ids/marketplace-name.js';
import { RepoMarketplace } from '../../src/types/marketplace-origin.js';
import { claudeCli } from '../../src/infrastructure/claude-cli.js';
import { createSession } from '../../src/infrastructure/session.js';
import type { HarnessEvent } from '../../src/types/harness.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import type {
  FetchLike,
  FetchResponseLike,
  RunCommand,
  RunResult,
  SourceFetcher,
} from '../../src/types/ports.js';
import { ok } from '../../src/types/result.js';
import type { MarketplaceEvent, MarketplaceListener, Session } from '../../src/types/session.js';
import { cleanupAll, portsFor, runnerFor, silenceConsole, stubFetch, tmpDir } from '../helpers.js';

test.after(cleanupAll);

/** A session over one stubbed fetch, both clients built the way production builds them. */
const sessionWith = (fetchImpl: FetchLike, notify?: MarketplaceListener): Session => {
  const ports = portsFor(fetchImpl);
  return createSession({ registry: registryClient(ports), fetcher: sourceFetcher(ports), notify });
};

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const con = silenceConsole();
  try {
    return await fn();
  } finally {
    con.restore();
  }
}

test('a session reads a marketplace registry once however many plugins ask for it', async () => {
  const repo = 'acme/plugin-marketplace';
  const registry = rawUrl(repo, 'main', '.claude-plugin/marketplace.json');
  const fetchImpl = stubFetch({
    [registry]: { body: { name: 'acme', plugins: [{ name: 'alpha' }, { name: 'beta' }] } },
  });
  const session = sessionWith(fetchImpl);

  const first = await session.catalog({ repo, ref: 'main' });
  const second = await session.catalog({ repo, ref: 'main' });

  assert.ok(first.ok && second.ok);
  assert.equal(first.value?.marketplace, 'acme');
  assert.equal(second.value?.marketplace, 'acme');
  assert.equal(fetchImpl.calls.filter((u) => u === registry).length, 1);
  await session.cleanup();
});

/**
 * The reason the skipped-file line is an event and not a field on the result.
 * Reporting it from what `catalog()` returns puts it at the caller, which reads
 * the memoised value once per plugin - so `update` across three plugins in one
 * repo said the same sentence three times. Emitted inside the cached promise, it
 * is said as often as the work is done: once.
 */
test('a registry file skipped once is reported once, however many plugins ask', async () => {
  const repo = 'acme/plugin-marketplace';
  const fetchImpl = stubFetch({
    [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: { body: ['not', 'an', 'object'] },
    [rawUrl(repo, 'main', '.cursor-plugin/marketplace.json')]: {
      body: { name: 'acme', plugins: [{ name: 'alpha' }] },
    },
  });
  const events: MarketplaceEvent[] = [];
  const session = sessionWith(fetchImpl, (e: MarketplaceEvent) => events.push(e));

  for (const _plugin of ['alpha', 'beta', 'gamma']) {
    const read = await session.catalog({ repo, ref: 'main' });
    assert.ok(read.ok);
  }

  assert.deepEqual(events, [
    { kind: 'registry-skipped', file: '.claude-plugin/marketplace.json', repo },
  ]);
  await session.cleanup();
});

/**
 * `sameEntry` only folds rows that share a plugin id, so two plugins recorded
 * from one GitHub repository in two spellings is a state today's code can be in
 * - and `update` builds each row's brand from its own `repo` field. Keying the
 * memo on the spelling made that one repository fetched and cloned twice, and
 * announced twice, which is the opposite of what this memo is for.
 */
test('two spellings of one repository are one piece of shared work', async () => {
  const registry = rawUrl('Acme/M', 'main', '.claude-plugin/marketplace.json');
  const lower = rawUrl('acme/m', 'main', '.claude-plugin/marketplace.json');
  const fetchImpl = stubFetch({
    [registry]: { body: { name: 'acme', plugins: [{ name: 'alpha' }] } },
    [lower]: { body: { name: 'acme', plugins: [{ name: 'alpha' }] } },
  });
  const session = sessionWith(fetchImpl);

  await session.catalog({ repo: 'Acme/M', ref: 'main' });
  await session.catalog({ repo: 'acme/m', ref: 'main' });

  assert.equal(fetchImpl.calls.length, 1, `read the same registry ${fetchImpl.calls.length} times`);
  await session.cleanup();
});

test('a marketplace spelled two ways is registered with Claude once', async () => {
  const { exec, calls } = recordingExec();
  const session = sessionWith(stubFetch({}));

  await quietly(async () => {
    for (const repo of ['Acme/M', 'acme/m']) {
      await new ClaudeHarness().ensureMarketplaceOnce(
        claudeCli('claude', runnerFor(exec)),
        RepoMarketplace.named(repo, new MarketplaceName('acme')),
        session,
        () => {},
      );
    }
  });

  const adds = calls.filter((c) => c.startsWith('plugin marketplace add')).length;
  assert.equal(adds, 1, `expected one registration, got ${adds}: ${calls.join(' | ')}`);
  await session.cleanup();
});

test('a session keeps separate registries for separate marketplaces', async () => {
  const one = 'acme/plugin-marketplace';
  const two = 'other/plugin-marketplace';
  const fetchImpl = stubFetch({
    [rawUrl(one, 'main', '.claude-plugin/marketplace.json')]: {
      body: { name: 'acme', plugins: [] },
    },
    [rawUrl(two, 'main', '.claude-plugin/marketplace.json')]: {
      body: { name: 'other', plugins: [] },
    },
  });
  const session = sessionWith(fetchImpl);

  const first = await session.catalog({ repo: one, ref: 'main' });
  const second = await session.catalog({ repo: two, ref: 'main' });
  assert.ok(first.ok && second.ok);
  assert.equal(first.value?.marketplace, 'acme');
  assert.equal(second.value?.marketplace, 'other');
  await session.cleanup();
});

/**
 * One workspace per repo@ref, opened once and disposed once. The shape this
 * replaces asserted two disposals for two plugins, because it drove the old
 * `deps.materialize` hook - which fetched per plugin and had no memo.
 * Production never set that hook, so what it measured was the test seam.
 *
 * It counts `openRepo` calls and not only disposals, because disposals alone
 * cannot see the memo break: `repos.set(key, ...)` overwrites, so the map holds
 * one handle per key whether or not the memo was consulted, and the first
 * version of this test passed with the memo removed.
 */
test('a session opens each repo workspace once, and disposes it at the end', async () => {
  const opened: string[] = [];
  const disposed: string[] = [];
  const fetcher: SourceFetcher = {
    openRepo: async ({ repo, ref }) => {
      opened.push(`${repo}@${ref}`);
      return {
        via: 'api',
        cleanup: () => disposed.push(repo),
        checkout: async () => ok(new DirectoryPath('/tmp/whatever')),
      };
    },
  };
  const session = createSession({ registry: registryClient(portsFor(stubFetch({}))), fetcher });

  await session.source({ repo: 'a/b', ref: 'main', sourcePath: 'plugins/alpha' });
  await session.source({ repo: 'a/b', ref: 'main', sourcePath: 'plugins/beta' });
  await session.source({ repo: 'A/B', ref: 'main', sourcePath: 'plugins/gamma' });
  await session.source({ repo: 'c/d', ref: 'main', sourcePath: 'plugins/alpha' });

  assert.deepEqual(
    opened,
    ['a/b@main', 'c/d@main'],
    'one clone per repo@ref, with the repo case folded',
  );
  assert.deepEqual(disposed, [], 'nothing is disposed mid-run');

  await session.cleanup();
  assert.deepEqual(disposed.sort(), ['a/b', 'c/d'], 'one disposal per repo, not per plugin');
});

/**
 * The guarantee the one-shot fetch's own try/catch used to make, asserted at the
 * level that makes it now. The workspace belongs to the repo handle the session
 * memoised, so a body that dies mid-read leaves the session still holding it -
 * and `cleanup`, which the router calls in a `finally`, is what removes it. A
 * second owner inside the fetcher is what this replaces, not what it lost.
 */
test('a checkout that throws leaves the session able to remove the workspace', async () => {
  const root = tmpDir('cp-tmproot-');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;

  const repo = 'acme/marketplace';
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`;
  const fetchImpl = async (url: string): Promise<FetchResponseLike> => {
    const body = JSON.stringify({ tree: [{ type: 'blob', path: 'plugins/alpha/plugin.json' }] });
    if (url === treeUrl) {
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => {
        throw new Error('connection reset while reading the body');
      },
    };
  };

  const workspaces = (): string[] =>
    fs.readdirSync(root).filter((n) => n.startsWith('context-plugins-'));

  try {
    // An empty PATH forces the API route, so the throw is the body and not git.
    const ports = portsFor(fetchImpl, { PATH: '', PATHEXT: '' });
    const session = createSession({
      registry: registryClient(ports),
      fetcher: sourceFetcher(ports),
    });

    await assert.rejects(
      session.source({ repo, ref: 'main', sourcePath: 'plugins/alpha' }),
      /connection reset/,
    );
    assert.equal(workspaces().length, 1, 'the session opened a workspace');

    await session.cleanup();
    assert.deepEqual(workspaces(), [], 'the session did not dispose the workspace');
  } finally {
    process.env.TMPDIR = saved.TMPDIR;
    process.env.TEMP = saved.TEMP;
    process.env.TMP = saved.TMP;
  }
});

/** A `claude` CLI stub: records every invocation, reports an empty marketplace list. */
function recordingExec(): { exec: RunCommand; calls: string[] } {
  const calls: string[] = [];
  const exec = async (_bin: string, args: string[]): Promise<RunResult> => {
    calls.push(args.join(' '));
    if (args[2] === 'list') return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/**
 * Both halves of the memo, because they can fail apart. The registration is one
 * `marketplace add` for three plugins - and it is announced once, because the
 * event fires inside the cached promise rather than being reported from what it
 * returns. Emitted at the caller instead, the line would be said once per
 * plugin while the work happened once: the shape of the Phase 2b regression,
 * and the reason a harness emits rather than returning facts.
 */
test('the Claude marketplace is registered once per session, and said once', async () => {
  const repo = 'acme/plugin-marketplace';
  const { exec, calls } = recordingExec();
  const session = sessionWith(stubFetch({}));
  const events: HarnessEvent[] = [];

  for (const _plugin of ['alpha', 'beta', 'gamma']) {
    await new ClaudeHarness().ensureMarketplaceOnce(
      claudeCli('claude', runnerFor(exec)),
      RepoMarketplace.named(repo, new MarketplaceName('acme')),
      session,
      (e) => events.push(e),
    );
  }

  const adds = calls.filter((c) => c === `plugin marketplace add ${repo}`).length;
  assert.equal(adds, 1, `expected one registration for three plugins, got ${adds}`);
  assert.deepEqual(events, [{ harness: 'claude', kind: 'marketplace-added', marketplace: 'acme' }]);
  await session.cleanup();
});

test('without a session the marketplace is registered per call, as before', async () => {
  const repo = 'acme/plugin-marketplace';
  const { exec, calls } = recordingExec();

  await quietly(async () => {
    const cli = claudeCli('claude', runnerFor(exec));
    const harness = new ClaudeHarness();
    const origin = RepoMarketplace.named(repo, new MarketplaceName('acme'));
    await harness.ensureMarketplaceOnce(cli, origin, null, () => {});
    await harness.ensureMarketplaceOnce(cli, origin, null, () => {});
  });

  assert.equal(calls.filter((c) => c === `plugin marketplace add ${repo}`).length, 2);
});
