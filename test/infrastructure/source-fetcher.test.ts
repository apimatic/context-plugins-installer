import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  downloadPath,
  fetchTree,
  openRepo,
  pool,
  type GitTree,
} from '../../src/infrastructure/source-fetcher.js';
import type { Env } from '../../src/types/env.js';
import type { FetchResponseLike } from '../../src/types/ports.js';
import type { MarketplaceEvent } from '../../src/types/session.js';
import { cleanupAll, portsFor, silenceConsole, stubFetch, tmpDir } from '../helpers.js';

test.after(cleanupAll);

const REPO = 'acme/marketplace';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
const rawFile = (p: string): string => `https://raw.githubusercontent.com/${REPO}/main/${p}`;

/** An empty PATH is how a test forces the API route without touching the host. */
const NO_GIT: Env = { PATH: '', PATHEXT: '' };

const recorder = () => {
  const events: MarketplaceEvent[] = [];
  return { events, notify: (e: MarketplaceEvent) => events.push(e) };
};

test('a tree response that is not a JSON object is refused, not cast', async () => {
  const tree = await fetchTree(
    {
      repo: REPO,
      ref: 'main',
    },
    portsFor(stubFetch({ [TREE_URL]: { body: '[]' } })),
  );
  assert.equal(tree.ok, false);
  assert.match(tree.ok ? '' : tree.error.message, /not a JSON object/);
});

test('tree entries that are not blobs with a string path are dropped', async () => {
  const tree = await fetchTree(
    {
      repo: REPO,
      ref: 'main',
    },
    portsFor(
      stubFetch({
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
    ),
  );
  assert.ok(tree.ok);
  assert.deepEqual(
    tree.value.tree.map((n) => n.path),
    ['plugins/x/a.md'],
  );
  assert.equal(tree.value.truncated, false, 'a missing truncated flag is not truthy');
});

test('a truncated tree is reported to the listener, not printed', async () => {
  const seen = recorder();
  const tree = await fetchTree(
    {
      repo: REPO,
      ref: 'main',
      notify: seen.notify,
    },
    portsFor(stubFetch({ [TREE_URL]: { body: { truncated: true, tree: [] } } })),
  );
  assert.ok(tree.ok);
  assert.deepEqual(seen.events, [{ kind: 'tree-truncated' }]);
});

test('a tree entry that climbs out of the checkout is refused before any write', async () => {
  const work = tmpDir('cp-work-');
  const escapee = 'plugins/x/../../../../../escaped.txt';
  const tree: GitTree = { truncated: false, tree: [{ type: 'blob', path: escapee }] };

  const dest = await downloadPath(
    {
      tree,
      repo: REPO,
      ref: 'main',
      sourcePath: 'plugins/x',
      work,
    },
    portsFor(stubFetch({ [rawFile(escapee)]: { body: 'pwned' } })),
  );
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
  const dest = await downloadPath(
    {
      tree,
      repo: REPO,
      ref: 'main',
      sourcePath: 'plugins/x',
      work,
    },
    portsFor(stubFetch(Object.fromEntries(files.map((p) => [rawFile(p), { body: `# ${p}` }])))),
  );
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

  const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
  try {
    const alpha = await handle.checkout('plugins/alpha');
    const beta = await handle.checkout('plugins/beta');

    assert.ok(alpha.ok && beta.ok);
    assert.ok(fs.existsSync(alpha.value.file('plugin.json').toString()), 'alpha was written');
    assert.ok(fs.existsSync(beta.value.file('plugin.json').toString()), 'beta was written');
    assert.notEqual(
      alpha.value.toString(),
      beta.value.toString(),
      'each plugin gets its own directory',
    );

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

  const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
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

test('the git probe reads the injected env, not the host PATH', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
    [rawFile(blob)]: { body: { name: 'alpha' } },
  });

  const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
  try {
    assert.equal(handle.via, 'api', 'an empty PATH must force the API route');
    const dir = await handle.checkout('plugins/alpha');
    assert.ok(dir.ok);
    assert.ok(fs.existsSync(dir.value.file('plugin.json').toString()));
  } finally {
    handle.cleanup();
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
  let handle;
  let dir;
  try {
    handle = await openRepo(
      { repo: REPO, ref: 'main', notify: seen.notify },
      portsFor(fetchImpl, NO_GIT),
    );
    dir = await handle.checkout('plugins/alpha');
  } finally {
    con.restore();
  }

  assert.ok(dir.ok);
  handle.cleanup();
  assert.deepEqual(con.lines, [], 'infrastructure printed something');
  assert.deepEqual(seen.events, [{ kind: 'no-git' }, { kind: 'downloaded', files: 1 }]);
});

test('a failed download is a failure, not a throw', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = stubFetch({
    [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
    // A 4xx, so this stays a test of the specific message; a 5xx is generic and
    // has its own test below.
    [rawFile(blob)]: { status: 403 },
  });

  const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
  try {
    const dir = await handle.checkout('plugins/alpha');
    assert.equal(dir.ok, false);
    assert.match(dir.ok ? '' : dir.error.message, /Download failed \(403\)/);
  } finally {
    handle.cleanup();
  }
});

/**
 * Both halves of the API route reach GitHub, and they reach different hosts, so
 * each pins its own: the host is the half of the sentence that survives on
 * purpose - a user behind a proxy needs to know which one failed - so a blank or
 * wrong one has to fail a test rather than only the status. One of the two uses
 * HTTP 500 itself, the status GitHub emits most and the literal in the code.
 */
test('a 5xx on the tree names api.github.com and says the far end is down', async () => {
  const handle = await openRepo(
    { repo: REPO, ref: 'main' },
    portsFor(stubFetch({ [TREE_URL]: { status: 500 } }), NO_GIT),
  );
  try {
    const dir = await handle.checkout('plugins/alpha');
    assert.equal(dir.ok, false);
    const message = dir.ok ? '' : dir.error.message;
    assert.equal(message, 'api.github.com is temporarily unavailable (HTTP 500).');
  } finally {
    handle.cleanup();
  }
});

test('a 5xx on a blob names raw.githubusercontent.com, and not the file', async () => {
  const blob = 'plugins/alpha/plugin.json';
  const handle = await openRepo(
    { repo: REPO, ref: 'main' },
    portsFor(
      stubFetch({
        [TREE_URL]: { body: { tree: [{ type: 'blob', path: blob }] } },
        [rawFile(blob)]: { status: 503 },
      }),
      NO_GIT,
    ),
  );
  try {
    const dir = await handle.checkout('plugins/alpha');
    assert.equal(dir.ok, false);
    const message = dir.ok ? '' : dir.error.message;
    assert.equal(message, 'raw.githubusercontent.com is temporarily unavailable (HTTP 503).');
    assert.ok(!message.includes(blob), 'the file path stays out of it');
  } finally {
    handle.cleanup();
  }
});

/**
 * And the control this site was missing. The commit that added the 5xx guard
 * above this branch claimed a test pinned the 4xx one; that was true of the
 * registry read and of a blob download, and false here - so the guard could
 * have widened over the `GITHUB_TOKEN` hint unnoticed.
 */
test('a 4xx on the tree still names the request and the token that fixes it', async () => {
  const handle = await openRepo(
    { repo: REPO, ref: 'main' },
    portsFor(stubFetch({ [TREE_URL]: { status: 403 } }), NO_GIT),
  );
  try {
    const dir = await handle.checkout('plugins/alpha');
    assert.equal(dir.ok, false);
    assert.match(dir.ok ? '' : dir.error.message, /GitHub API request failed \(403/);
    assert.match(dir.ok ? '' : (dir.error.hint ?? ''), /GITHUB_TOKEN/);
  } finally {
    handle.cleanup();
  }
});

/**
 * The workspace belongs to the handle, not to one checkout, so a body that dies
 * mid-read has to leave it disposable rather than orphaned: `handle.cleanup()`
 * is what removes it, and the session's `cleanup` - which the router calls in a
 * `finally` - is what reaches it on a real run. The shape this replaces gave the
 * one-shot fetch a try/catch of its own, which is the second owner that made
 * two of every decision in this module.
 *
 * The temp root is redirected so the check is exact rather than a count of
 * whatever else the machine has in /tmp.
 */
test('a fetch that throws leaves a workspace the handle still removes', async () => {
  const root = tmpDir('cp-tmproot-');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;

  const blob = 'plugins/alpha/plugin.json';
  const fetchImpl = async (url: string): Promise<FetchResponseLike> => {
    const body = JSON.stringify({ tree: [{ type: 'blob', path: blob }] });
    if (url === TREE_URL) {
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
    const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
    assert.equal(workspaces().length, 1, 'the handle opened a workspace');

    await assert.rejects(handle.checkout('plugins/alpha'), /connection reset/);
    assert.equal(workspaces().length, 1, 'a throw must not orphan the workspace');

    handle.cleanup();
    assert.deepEqual(workspaces(), [], 'the workspace outlived its handle');
  } finally {
    process.env.TMPDIR = saved.TMPDIR;
    process.env.TEMP = saved.TEMP;
    process.env.TMP = saved.TMP;
  }
});

test('pool preserves input order regardless of completion order', async () => {
  const items = [30, 5, 20, 1, 10];
  const results = await pool(items, 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(results, items);
});
