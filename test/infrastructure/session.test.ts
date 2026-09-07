import test from 'node:test';
import assert from 'node:assert';

import { rawUrl } from '../../src/infrastructure/github-registry-client.js';
import { ClaudeHarness } from '../../src/harnesses/claude.js';
import { claudeCli } from '../../src/infrastructure/claude-cli.js';
import { createSession } from '../../src/infrastructure/session.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import type { RunCommand, RunResult } from '../../src/types/ports.js';
import type { MarketplaceEvent } from '../../src/types/session.js';
import { cleanupAll, stubFetch, silenceConsole } from '../helpers.js';

test.after(cleanupAll);

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
  const session = createSession({ deps: { fetchImpl, env: {} } });

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
  const session = createSession({
    deps: { fetchImpl, env: {} },
    notify: (e) => events.push(e),
  });

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
  const session = createSession({ deps: { fetchImpl, env: {} } });

  await session.catalog({ repo: 'Acme/M', ref: 'main' });
  await session.catalog({ repo: 'acme/m', ref: 'main' });

  assert.equal(fetchImpl.calls.length, 1, `read the same registry ${fetchImpl.calls.length} times`);
  await session.cleanup();
});

test('a marketplace spelled two ways is registered with Claude once', async () => {
  const { exec, calls } = recordingExec();
  const session = createSession({ deps: {} });

  await quietly(async () => {
    for (const repo of ['Acme/M', 'acme/m']) {
      await new ClaudeHarness().ensureMarketplaceOnce(
        claudeCli('claude', exec),
        { marketplace: 'acme', repo },
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
  const session = createSession({ deps: { fetchImpl, env: {} } });

  const first = await session.catalog({ repo: one, ref: 'main' });
  const second = await session.catalog({ repo: two, ref: 'main' });
  assert.ok(first.ok && second.ok);
  assert.equal(first.value?.marketplace, 'acme');
  assert.equal(second.value?.marketplace, 'other');
  await session.cleanup();
});

test('session cleanup disposes what an injected fetch handed back', async () => {
  let disposed = 0;
  const session = createSession({
    deps: {
      materialize: async () => ({
        dir: new DirectoryPath('/tmp/whatever'),
        cleanup: () => {
          disposed += 1;
        },
        via: 'stub',
      }),
    },
  });

  await session.source({ repo: 'a/b', ref: 'main', sourcePath: 'plugins/alpha' });
  await session.source({ repo: 'a/b', ref: 'main', sourcePath: 'plugins/beta' });
  assert.equal(disposed, 0, 'nothing is disposed mid-run');

  await session.cleanup();
  assert.equal(disposed, 2, 'every fetch is disposed at the end of the run');
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

test('the Claude marketplace is registered once per session, not once per plugin', async () => {
  const repo = 'acme/plugin-marketplace';
  const { exec, calls } = recordingExec();
  const session = createSession({ deps: {} });

  await quietly(async () => {
    for (const _plugin of ['alpha', 'beta', 'gamma']) {
      await new ClaudeHarness().ensureMarketplaceOnce(
        claudeCli('claude', exec),
        { marketplace: 'acme', repo },
        session,
        () => {},
      );
    }
  });

  const adds = calls.filter((c) => c === `plugin marketplace add ${repo}`).length;
  assert.equal(adds, 1, `expected one registration for three plugins, got ${adds}`);
  await session.cleanup();
});

test('without a session the marketplace is registered per call, as before', async () => {
  const repo = 'acme/plugin-marketplace';
  const { exec, calls } = recordingExec();

  await quietly(async () => {
    const cli = claudeCli('claude', exec);
    const harness = new ClaudeHarness();
    await harness.ensureMarketplaceOnce(cli, { marketplace: 'acme', repo }, null, () => {});
    await harness.ensureMarketplaceOnce(cli, { marketplace: 'acme', repo }, null, () => {});
  });

  assert.equal(calls.filter((c) => c === `plugin marketplace add ${repo}`).length, 2);
});
