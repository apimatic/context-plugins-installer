import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  downloadPath,
  fetchTree,
  materialize,
  openRepo,
  pool,
  type GitTree,
} from '../../src/infrastructure/source-fetcher.js';
import type { Env } from '../../src/types/env.js';
import type { SourceEvent } from '../../src/types/session.js';
import { tmpDir, cleanupAll, stubFetch, silenceConsole } from '../helpers.js';

test.after(cleanupAll);

const REPO = 'acme/marketplace';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
const rawFile = (p: string): string => `https://raw.githubusercontent.com/${REPO}/main/${p}`;

/** An empty PATH is how a test forces the API route without touching the host. */
const NO_GIT: Env = { PATH: '', PATHEXT: '' };

const recorder = () => {
  const events: SourceEvent[] = [];
  return { events, notify: (e: SourceEvent) => events.push(e) };
};

test('a tree response that is not a JSON object is refused, not cast', async () => {
  const tree = await fetchTree({
    repo: REPO,
    ref: 'main',
    deps: { fetchImpl: stubFetch({ [TREE_URL]: { body: '[]' } }) },
  });
  assert.equal(tree.ok, false);
  assert.match(tree.ok ? '' : tree.error.message, /not a JSON object/);
});

test('tree entries that are not blobs with a string path are dropped', async () => {
  const tree = await fetchTree({
    repo: REPO,
    ref: 'main',
    deps: {
      fetchImpl: stubFetch({
        [TREE_URL]: {
          body: {
            tree: [
              { type: 'blob', path: 'plugins/x/a.md' },
              { type: 'blob', path: 42 },
              { type: 'blob' },
              { path: 'plugins/x/no-type.md' },
              'plugins/x/b.md',
              null,
            ],
          },
        },
      }),
    },
  });
  assert.ok(tree.ok);
  assert.deepEqual(
    tree.value.tree.map((n) => n.path),
    ['plugins/x/a.md'],
  );
  assert.equal(tree.value.truncated, false, 'a missing truncated flag is not truthy');
});

test('a truncated tree is reported to the listener, not printed', async () => {
  const seen = recorder();
  const tree = await fetchTree({
    repo: REPO,
    ref: 'main',
    deps: { fetchImpl: stubFetch({ [TREE_URL]: { body: { truncated: true, tree: [] } } }) },
    notify: seen.notify,
  });
  assert.ok(tree.ok);
  assert.deepEqual(seen.events, [{ kind: 'tree-truncated' }]);
});

test('a tree entry that climbs out of the checkout is refused before any write', async () => {
  const work = tmpDir('cp-work-');
  const escapee = 'plugins/x/../../../../../escaped.txt';
  const tree: GitTree = { truncated: false, tree: [{ type: 'blob', path: escapee }] };

  const dest = await downloadPath({
    tree,
    repo: REPO,
    ref: 'main',
    sourcePath: 'plugins/x',
    work,
    deps: { fetchImpl: stubFetch({ [rawFile(escapee)]: { body: 'pwned' } }) },
  });
  assert.equal(dest.ok, false);
  assert.match(dest.ok ? '' : dest.error.message, /outside the checkout/);
  assert.equal(fs.existsSync(path.join(work, '..', '..', 'escaped.txt')), false);
});

test('a well-formed tree lands under the checkout', async () => {
  const work = tmpDir('cp-work-');
  const files = ['plugins/x/skills/a.md', 'plugins/x/skills/b.md', 'plugins/x/plugin.json'];
  const tree: GitTree = {
    truncated: false,
    tree: files.map((p) => ({ type: 'blob', path: p })),
  };
  const dest = await downloadPath({
    tree,
    repo: REPO,
    ref: 'main',
    sourcePath: 'plugins/x',
    work,
    deps: {
      fetchImpl: stubFetch(Object.fromEntries(files.map((p) => [rawFile(p), { body: `# ${p}` }]))),
    },
  });
  assert.ok(dest.ok);
  // Two files share a directory, so the second one takes the memoised mkdir.
  assert.equal(
    fs.readFileSync(path.join(dest.value, 'skills', 'a.md'), 'utf8'),
    '# plugins/x/skills/a.md',
  );
  assert.equal(
    fs.readFileSync(path.join(dest.value, 'skills', 'b.md'), 'utf8'),
    '# plugins/x/skills/b.md',
  );
  assert.ok(fs.existsSync(path.join(dest.value, 'plugin.json')));
});

test('one repo handle fetches the API tree once and serves every plugin from it', async () => {
  const fetchImpl = stubFetch({
    [TREE_URL]: {
      body: {
        tree: [
          { type: 'blob', path: 'plugins/alpha/plugin.json' },
          { type: 'blob', path: 'plugins/beta/plugin.json' },
        ],
      },
    },
    [rawFile('plugins/alpha/plugin.json')]: { body: { name: 'alpha' } },
    [rawFile('plugins/beta/plugin.json')]: { body: { name: 'beta' } },
  });

  const handle = await openRepo({ repo: REPO, ref: 'main', deps: { fetchImpl, env: NO_GIT } });
  try {
    const alpha = await handle.checkout('plugins/alpha');
    const beta = await handle.checkout('plugins/beta');

    assert.ok(alpha.ok && beta.ok);
    assert.ok(fs.existsSync(path.join(alpha.value, 'plugin.json')), 'alpha was written');
    assert.ok(fs.existsSync(path.join(beta.value, 'plugin.json')), 'beta was written');
    assert.notEqual(alpha.value, beta.value, 'each plugin gets its own directory');

    const trees = fetchImpl.calls.filter((u) => u === TREE_URL).length;
    assert.equal(trees, 1, `expected the tree to be fetched once, got ${trees}`);
  } finally {
    handle.cleanup();
  }
});

test('checking the same plugin out twice does not download it again', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [rawFile(blob)]: { body: { name: 'alpha' } },
  });

  const handle = await openRepo({ repo: REPO, ref: 'main', deps: { fetchImpl, env: NO_GIT } });
  try {
    const first = await handle.checkout('plugins/alpha');
    const second = await handle.checkout('plugins/alpha');
    assert.ok(first.ok && second.ok);
    assert.equal(first.value, second.value);
    assert.equal(fetchImpl.calls.filter((u) => u === rawFile(blob)).length, 1);
  } finally {
    handle.cleanup();
  }
});

test('materialize honours an injected env when probing for git', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [rawFile(blob)]: { body: { name: 'alpha' } },
  });

  const result = await materialize({
    repo: REPO,
    ref: 'main',
    sourcePath: 'plugins/alpha',
    deps: { fetchImpl, env: NO_GIT },
  });
  assert.ok(result.ok);
  try {
    assert.equal(result.value.via, 'api', 'an empty PATH must force the API route');
    assert.ok(fs.existsSync(path.join(result.value.dir, 'plugin.json')));
  } finally {
    result.value.cleanup();
  }
});

/**
 * The phase's exit condition, asserted rather than assumed: the fetcher says
 * everything through the listener and nothing through the terminal. Every one of
 * these lines used to be a `log` call, and the missing-git warning has to arrive
 * before the slow fallback it explains, which is why it is an event at the
 * moment it happens and not a field on the result.
 */
test('a fallback to the API is announced to the listener, and printed by nobody', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [rawFile(blob)]: { body: { name: 'alpha' } },
  });
  const seen = recorder();

  const con = silenceConsole();
  let result;
  try {
    result = await materialize({
      repo: REPO,
      ref: 'main',
      sourcePath: 'plugins/alpha',
      deps: { fetchImpl, env: NO_GIT },
      notify: seen.notify,
    });
  } finally {
    con.restore();
  }

  assert.ok(result.ok);
  result.value.cleanup();
  assert.deepEqual(con.lines, [], 'infrastructure printed something');
  assert.deepEqual(seen.events, [{ kind: 'no-git' }, { kind: 'downloaded', files: 1 }]);
});

test('a failed download is a failure, not a throw, and takes the workspace with it', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [rawFile(blob)]: { status: 500 },
  });

  const result = await materialize({
    repo: REPO,
    ref: 'main',
    sourcePath: 'plugins/alpha',
    deps: { fetchImpl, env: NO_GIT },
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /Download failed \(500\)/);
});

test('pool preserves input order regardless of completion order', async () => {
  const items = [30, 5, 20, 1, 10];
  const results = await pool(items, 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(results, items);
});
