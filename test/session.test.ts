import test from 'node:test';
import assert from 'node:assert';

import { rawUrl } from '../src/infrastructure/github-registry-client.js';
import * as claude from '../src/harness/claude.js';
import { createSession } from '../src/session.js';
import type { RunCommand, RunResult } from '../src/types/ports.js';
import { cleanupAll, stubFetch, silenceConsole } from './helpers.js';

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

  assert.equal(first?.marketplace, 'acme');
  assert.equal(second?.marketplace, 'acme');
  assert.equal(fetchImpl.calls.filter((u) => u === registry).length, 1);
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

  assert.equal((await session.catalog({ repo: one, ref: 'main' }))?.marketplace, 'acme');
  assert.equal((await session.catalog({ repo: two, ref: 'main' }))?.marketplace, 'other');
  await session.cleanup();
});

test('session cleanup disposes what an injected fetch handed back', async () => {
  let disposed = 0;
  const session = createSession({
    deps: {
      materialize: async () => ({
        dir: '/tmp/whatever',
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
      await claude.ensureMarketplaceOnce(exec, 'claude', { marketplace: 'acme', repo }, session);
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
    await claude.ensureMarketplaceOnce(exec, 'claude', { marketplace: 'acme', repo }, null);
    await claude.ensureMarketplaceOnce(exec, 'claude', { marketplace: 'acme', repo }, null);
  });

  assert.equal(calls.filter((c) => c === `plugin marketplace add ${repo}`).length, 2);
});
