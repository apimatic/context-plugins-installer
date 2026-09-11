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
import { RepoSlug } from '../../src/types/ids/repo-slug.js';
import type { FetchResponseLike, RunCommand, SourcePorts } from '../../src/types/ports.js';
import type { MarketplaceEvent } from '../../src/types/session.js';
import { cleanupAll, portsFor, runnerFor, silenceConsole, stubFetch, tmpDir } from '../helpers.js';

test.after(cleanupAll);

const REPO = 'acme/marketplace';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
const rawFile = (p: string): string => `https://raw.githubusercontent.com/${REPO}/main/${p}`;
/** The same file at the API, which is where a raw outage sends the download. */
const apiFile = (p: string): string => new RepoSlug(REPO).contentsUrl('main', p);

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

/**
 * The same fallback the registry read has, at the other place this program
 * fetches a file by URL: a plugin is downloaded a blob at a time, and a 503
 * from the CDN on any one of them used to fail the whole install.
 */
test('a blob the raw CDN 503s on is downloaded from the GitHub API instead', async () => {
  const work = tmpDir('cp-work-');
  const blob = 'plugins/x/skills/a.md';
  const tree: GitTree = { truncated: false, tree: [{ type: 'blob', path: blob }] };
  const fetchImpl = stubFetch({
    [rawFile(blob)]: { status: 503 },
    [apiFile(blob)]: { body: '# from the API' },
  });
  const seen = recorder();

  const dest = await downloadPath(
    { tree, repo: REPO, ref: 'main', sourcePath: 'plugins/x', work, notify: seen.notify },
    portsFor(fetchImpl),
  );

  assert.ok(dest.ok);
  assert.equal(fs.readFileSync(path.join(dest.value, 'skills', 'a.md'), 'utf8'), '# from the API');
  assert.deepEqual(fetchImpl.calls, [rawFile(blob), apiFile(blob)]);
  assert.deepEqual(seen.events, [
    { kind: 'raw-outage', host: 'raw.githubusercontent.com', status: 503 },
    { kind: 'downloaded', files: 1 },
  ]);
});

/**
 * One outage, one line. The fallback is per file and eight of them are in
 * flight at once, so a listener that heard about each would print the same
 * sentence once per blob in the plugin - which is how a folder of forty files
 * turns an explanation into a wall.
 */
test('a folder that falls back on every file says so once, not once per file', async () => {
  const work = tmpDir('cp-work-');
  const files = ['plugins/x/a.md', 'plugins/x/b.md', 'plugins/x/c.md'];
  const tree: GitTree = { truncated: false, tree: files.map((p) => ({ type: 'blob', path: p })) };
  const fetchImpl = stubFetch(
    Object.fromEntries([
      ...files.map((p) => [rawFile(p), { status: 503 }]),
      ...files.map((p) => [apiFile(p), { body: `# ${p}` }]),
    ]),
  );
  const seen = recorder();

  const dest = await downloadPath(
    { tree, repo: REPO, ref: 'main', sourcePath: 'plugins/x', work, notify: seen.notify },
    portsFor(fetchImpl),
  );

  assert.ok(dest.ok);
  assert.equal(fs.readFileSync(path.join(dest.value, 'c.md'), 'utf8'), '# plugins/x/c.md');
  assert.equal(seen.events.filter((e) => e.kind === 'raw-outage').length, 1);
  assert.equal(fetchImpl.calls.length, files.length * 2, 'every file still asked both hosts');
});

/** A blob that neither host will serve is the CDN's outage, not the API's 404. */
test('a blob the API cannot serve either keeps the outage the CDN reported', async () => {
  const work = tmpDir('cp-work-');
  const blob = 'plugins/x/a.md';
  const tree: GitTree = { truncated: false, tree: [{ type: 'blob', path: blob }] };

  const dest = await downloadPath(
    { tree, repo: REPO, ref: 'main', sourcePath: 'plugins/x', work },
    portsFor(stubFetch({ [rawFile(blob)]: { status: 503 } })),
  );

  assert.equal(dest.ok, false);
  const message = dest.ok ? '' : dest.error.message;
  assert.equal(message, 'raw.githubusercontent.com is temporarily unavailable (HTTP 503).');
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

/**
 * A `git` on PATH and a fake behind it that builds the working tree the real
 * one would: a `--sparse` clone holds the top level and nothing else, `add`
 * fills in one folder, and `disable` fills in the rest. Recording the argv is
 * the point - what this phase changed is which commands are run, and a test
 * that only asserted the directory came back would pass with the sparse
 * checkout narrowed right back down again.
 */
function fakeGit(): { ports: SourcePorts; argv: string[][] } {
  const bin = tmpDir('cp-git-');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'git.cmd'), '@echo off\n');
  const env: Env = { PATH: bin, PATHEXT: '.CMD' };
  const argv: string[][] = [];
  const fill = (clone: string, under: string): void => {
    const dir = path.join(clone, ...under.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), '{}');
  };
  const run: RunCommand = async (_file, args) => {
    argv.push(args);
    if (args[0] === 'clone') {
      const clone = args[args.length - 1] as string;
      // Including the `.git` a real clone leaves behind, which is the whole
      // difference between a checkout of a folder and one of a repository.
      fs.mkdirSync(path.join(clone, '.git', 'objects'), { recursive: true });
      fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]');
      fs.writeFileSync(path.join(clone, '.git', 'objects', 'pack'), 'blob');
      fs.writeFileSync(path.join(clone, 'plugin.json'), '{ "name": "whole-repo" }');
    }
    if (args[2] === 'sparse-checkout') {
      fill(args[1] as string, args[3] === 'disable' ? 'tools/foo' : (args[4] as string));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { ports: { fetch: stubFetch({}), env, runner: runnerFor(run, env) }, argv };
}

const sparseCalls = (argv: string[][]): string[][] =>
  argv.filter((a) => a[2] === 'sparse-checkout');

test('a repository that is itself the plugin checks the whole tree out', async () => {
  // `sparse-checkout add ''` is not a way to ask for everything - it is an
  // error - so the clone's own sparseness is turned off instead and the clone
  // directory is the checkout.
  const { ports, argv } = fakeGit();
  const handle = await openRepo({ repo: REPO, ref: 'main' }, ports);
  try {
    assert.equal(handle.via, 'git');
    const dir = await handle.checkout(null);
    assert.ok(dir.ok, dir.ok ? '' : dir.error.message);
    assert.ok(fs.existsSync(dir.value.file('plugin.json').toString()), 'the root is the checkout');
    assert.deepEqual(
      sparseCalls(argv).map((a) => a.slice(2)),
      [['sparse-checkout', 'disable']],
    );
  } finally {
    handle.cleanup();
  }
});

test('a folder checked out after the whole repository is read, not narrowed back down', async () => {
  // `sparse-checkout add` after a `disable` re-narrows the working tree, which
  // would delete files out from under the directory the first checkout handed
  // back. Once the tree is whole, a folder is just a path into it.
  const { ports, argv } = fakeGit();
  const handle = await openRepo({ repo: REPO, ref: 'main' }, ports);
  try {
    const whole = await handle.checkout(null);
    const folder = await handle.checkout('tools/foo');
    assert.ok(whole.ok && folder.ok, 'both checkouts answer');
    assert.ok(fs.existsSync(folder.value.file('plugin.json').toString()));
    assert.ok(fs.existsSync(whole.value.file('plugin.json').toString()), 'the first one survives');
    assert.deepEqual(
      sparseCalls(argv).map((a) => a.slice(2)),
      [['sparse-checkout', 'disable']],
      'no add after the tree was filled',
    );
  } finally {
    handle.cleanup();
  }
});

test('the checkout of a whole repository is made once and remembered', async () => {
  const { ports, argv } = fakeGit();
  const handle = await openRepo({ repo: REPO, ref: 'main' }, ports);
  try {
    const first = await handle.checkout(null);
    const second = await handle.checkout(null);
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.toString(), second.value.toString());
    assert.equal(sparseCalls(argv).length, 1);
    assert.equal(argv.filter((a) => a[0] === 'clone').length, 1);
  } finally {
    handle.cleanup();
  }
});

test('the API route takes every blob when the repository is the plugin', async () => {
  const fetchImpl = stubFetch({
    [TREE_URL]: {
      body: {
        tree: [
          { type: 'blob', path: '.claude-plugin/plugin.json' },
          { type: 'blob', path: 'skills/thing/SKILL.md' },
          { type: 'tree', path: 'skills' },
        ],
      },
    },
    [rawFile('.claude-plugin/plugin.json')]: { body: { name: 'whole-repo' } },
    [rawFile('skills/thing/SKILL.md')]: { body: '# thing' },
  });

  const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
  try {
    const dir = await handle.checkout(null);
    assert.ok(dir.ok, dir.ok ? '' : dir.error.message);
    // Laid out as the repository is, with no folder stripped off the front:
    // an empty prefix is what makes the whole tree the plugin.
    assert.ok(fs.existsSync(dir.value.file('.claude-plugin', 'plugin.json').toString()));
    assert.ok(fs.existsSync(dir.value.file('skills', 'thing', 'SKILL.md').toString()));
  } finally {
    handle.cleanup();
  }
});

test('a repository with no files says so without naming a folder that does not exist', async () => {
  const fetchImpl = stubFetch({ [TREE_URL]: { body: { tree: [] } } });
  const handle = await openRepo({ repo: REPO, ref: 'main' }, portsFor(fetchImpl, NO_GIT));
  try {
    const dir = await handle.checkout(null);
    assert.equal(dir.ok, false);
    if (!dir.ok) assert.equal(dir.error.message, `${REPO}@main has no files.`);
  } finally {
    handle.cleanup();
  }
});

test('a whole-repository checkout counts the plugins files, not the clones', async () => {
  // `plugin.json` and the one file `disable` fills in - not the three-file
  // `.git` beside them, which is not part of the plugin and must not be
  // reported as though a user were getting it.
  const { ports } = fakeGit();
  const { events, notify } = recorder();
  const handle = await openRepo({ repo: REPO, ref: 'main', notify }, ports);
  try {
    const dir = await handle.checkout(null);
    assert.ok(dir.ok, dir.ok ? '' : dir.error.message);
    assert.deepEqual(
      events.filter((e) => e.kind === 'checked-out'),
      [{ kind: 'checked-out', files: 2 }],
    );
  } finally {
    handle.cleanup();
  }
});
