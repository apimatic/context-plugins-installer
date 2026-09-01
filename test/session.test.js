'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { openRepo } = require('../src/fetch');
const { createSession } = require('../src/session');
const claude = require('../src/harness/claude');
const { rawUrl } = require('../src/catalog');
const { cleanupAll, stubFetch, silenceConsole } = require('./helpers');

test.after(cleanupAll);

async function quietly(fn) {
  const con = silenceConsole();
  try {
    return await fn();
  } finally {
    con.restore();
  }
}

// An empty PATH means `which('git')` finds nothing, which is the only way to
// exercise the GitHub API path on a machine that has git installed.
const NO_GIT = { PATH: '', PATHEXT: '' };

test('one repo handle fetches the API tree once and serves every plugin from it', async () => {
  const repo = 'acme/plugin-marketplace';
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`;
  const raw = (p) => `https://raw.githubusercontent.com/${repo}/main/${p}`;
  const fetchImpl = stubFetch({
    [treeUrl]: {
      body: {
        tree: [
          { type: 'blob', path: 'plugins/alpha/plugin.json' },
          { type: 'blob', path: 'plugins/beta/plugin.json' },
        ],
      },
    },
    [raw('plugins/alpha/plugin.json')]: { body: { name: 'alpha' } },
    [raw('plugins/beta/plugin.json')]: { body: { name: 'beta' } },
  });

  const handle = await quietly(() =>
    openRepo({ repo, ref: 'main', deps: { fetchImpl, env: NO_GIT } }),
  );
  try {
    const alpha = await quietly(() => handle.checkout('plugins/alpha'));
    const beta = await quietly(() => handle.checkout('plugins/beta'));

    assert.ok(fs.existsSync(path.join(alpha, 'plugin.json')), 'alpha was written');
    assert.ok(fs.existsSync(path.join(beta, 'plugin.json')), 'beta was written');
    assert.notEqual(alpha, beta, 'each plugin gets its own directory');

    const trees = fetchImpl.calls.filter((u) => u === treeUrl).length;
    assert.equal(trees, 1, `expected the tree to be fetched once, got ${trees}`);
  } finally {
    handle.cleanup();
  }
});

test('checking the same plugin out twice does not download it again', async () => {
  const repo = 'acme/plugin-marketplace';
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`;
  const blob = 'plugins/alpha/plugin.json';
  const rawBlob = `https://raw.githubusercontent.com/${repo}/main/${blob}`;
  const fetchImpl = stubFetch({
    [treeUrl]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [rawBlob]: { body: { name: 'alpha' } },
  });

  const handle = await quietly(() =>
    openRepo({ repo, ref: 'main', deps: { fetchImpl, env: NO_GIT } }),
  );
  try {
    const first = await quietly(() => handle.checkout('plugins/alpha'));
    const second = await quietly(() => handle.checkout('plugins/alpha'));
    assert.equal(first, second);
    assert.equal(fetchImpl.calls.filter((u) => u === rawBlob).length, 1);
  } finally {
    handle.cleanup();
  }
});

test('a session reads a marketplace registry once however many plugins ask for it', async () => {
  const repo = 'acme/plugin-marketplace';
  const registry = rawUrl(repo, 'main', '.claude-plugin/marketplace.json');
  const fetchImpl = stubFetch({
    [registry]: { body: { name: 'acme', plugins: [{ name: 'alpha' }, { name: 'beta' }] } },
  });
  const session = createSession({ deps: { fetchImpl, env: {} } });

  const first = await session.catalog({ repo, ref: 'main' });
  const second = await session.catalog({ repo, ref: 'main' });

  assert.equal(first.marketplace, 'acme');
  assert.equal(second.marketplace, 'acme');
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

  assert.equal((await session.catalog({ repo: one, ref: 'main' })).marketplace, 'acme');
  assert.equal((await session.catalog({ repo: two, ref: 'main' })).marketplace, 'other');
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
function recordingExec() {
  const calls = [];
  const exec = async (_bin, args) => {
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

test('materialize honours an injected env when probing for git', async () => {
  const { materialize } = require('../src/fetch');
  const repo = 'acme/plugin-marketplace';
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`;
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [treeUrl]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [`https://raw.githubusercontent.com/${repo}/main/${blob}`]: { body: { name: 'alpha' } },
  });

  const result = await quietly(() =>
    materialize({
      repo,
      ref: 'main',
      sourcePath: 'plugins/alpha',
      deps: { fetchImpl, env: NO_GIT },
    }),
  );
  try {
    assert.equal(result.via, 'api', 'an empty PATH must force the API route');
    assert.ok(fs.existsSync(path.join(result.dir, 'plugin.json')));
  } finally {
    result.cleanup();
  }
});
