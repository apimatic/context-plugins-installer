import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { fetchTree, downloadPath, type GitTree } from '../src/fetch.js';
import { UserError } from '../src/util.js';
import { tmpDir, cleanupAll, stubFetch, silenceConsole } from './helpers.js';

test.after(cleanupAll);

const REPO = 'acme/marketplace';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
const rawFile = (p: string): string => `https://raw.githubusercontent.com/${REPO}/main/${p}`;

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const con = silenceConsole();
  try {
    return await fn();
  } finally {
    con.restore();
  }
};

test('a tree response that is not a JSON object is refused, not cast', async () => {
  await assert.rejects(
    fetchTree({
      repo: REPO,
      ref: 'main',
      deps: { fetchImpl: stubFetch({ [TREE_URL]: { body: '[]' } }) },
    }),
    (err) => err instanceof UserError && /not a JSON object/.test(err.message),
  );
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
  assert.deepEqual(
    tree.tree.map((n) => n.path),
    ['plugins/x/a.md'],
  );
  assert.equal(tree.truncated, false, 'a missing truncated flag is not truthy');
});

test('a tree entry that climbs out of the checkout is refused before any write', async () => {
  const work = tmpDir('cp-work-');
  const escapee = 'plugins/x/../../../../../escaped.txt';
  const tree: GitTree = { truncated: false, tree: [{ type: 'blob', path: escapee }] };

  await assert.rejects(
    quietly(() =>
      downloadPath({
        tree,
        repo: REPO,
        ref: 'main',
        sourcePath: 'plugins/x',
        work,
        deps: { fetchImpl: stubFetch({ [rawFile(escapee)]: { body: 'pwned' } }) },
      }),
    ),
    (err) => err instanceof UserError && /outside the checkout/.test(err.message),
  );
  assert.equal(fs.existsSync(path.join(work, '..', '..', 'escaped.txt')), false);
});

test('a well-formed tree lands under the checkout', async () => {
  const work = tmpDir('cp-work-');
  const tree: GitTree = {
    truncated: false,
    tree: [{ type: 'blob', path: 'plugins/x/skills/a.md' }],
  };
  const dest = await quietly(() =>
    downloadPath({
      tree,
      repo: REPO,
      ref: 'main',
      sourcePath: 'plugins/x',
      work,
      deps: { fetchImpl: stubFetch({ [rawFile('plugins/x/skills/a.md')]: { body: '# a' } }) },
    }),
  );
  assert.equal(fs.readFileSync(path.join(dest, 'skills', 'a.md'), 'utf8'), '# a');
});
