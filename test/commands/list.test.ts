import test from 'node:test';
import assert from 'node:assert';

import { rawUrl } from '../../src/infrastructure/github-registry-client.js';
import { runCli } from '../cli-harness.js';
import { cleanupAll, stubFetch } from '../helpers.js';

test.after(cleanupAll);

// `list` end to end. The marks and the payload shape are the action's
// (test/actions/list.test.ts); these are the warnings and where they land.

const REPO = 'context-plugins/plugin-marketplace';

const STATE_MANIFEST = {
  version: 1,
  plugins: [
    { plugin: 'my-sdk', repo: REPO, targets: ['claude'] },
    // Half readable: listed, but one target belongs to a build that is not this one.
    { plugin: 'code-review', repo: REPO, targets: ['vscode', 'zed'] },
    { plugin: 'future-sdk', repo: REPO, targets: ['zed'] },
    // Another marketplace entirely: `list` must not warn about it.
    { plugin: 'other-sdk', repo: 'acme/marketplace', targets: ['zed'] },
  ],
};

/** `list` fetches the registry and run() has no deps seam, so pin the global fetch. */
async function listWith(args: string[], manifestDoc: unknown) {
  const saved = globalThis.fetch;
  globalThis.fetch = stubFetch({
    [rawUrl(REPO, 'main', '.claude-plugin/marketplace.json')]: {
      body: {
        name: 'context-plugins',
        plugins: [
          { name: 'code-review', source: './plugins/code-review' },
          { name: 'future-sdk', source: './plugins/future-sdk' },
        ],
      },
    },
  }) as unknown as typeof globalThis.fetch;
  try {
    return await runCli(args, manifestDoc, { CP_REPO: REPO });
  } finally {
    globalThis.fetch = saved;
  }
}

test('list --json warns about the rows behind its installed marks, scoped to the marketplace', async () => {
  const { code, out, err } = await listWith(['list', '--json'], STATE_MANIFEST);
  assert.equal(code, 0);

  const payload: { plugins: { name: string; targets: string[]; installed: boolean }[] } =
    JSON.parse(out);
  const codeReview = payload.plugins.find((p) => p.name === 'code-review');
  assert.deepEqual(codeReview?.targets, ['vscode'], 'the row is listed without the zed target');
  assert.equal(
    payload.plugins.find((p) => p.name === 'future-sdk')?.installed,
    false,
    'and a row it cannot read at all reads as not installed - which is why it warns',
  );

  assert.ok(err.includes("Ignoring 'future-sdk' in installed.json - unknown target(s): zed."));
  assert.ok(err.includes("Listing 'code-review' without unknown target(s): zed"));
  assert.ok(!err.includes(REPO), 'the repo is implied by the listing, so it is left out');
  assert.ok(!err.includes('other-sdk'), 'another marketplace is not this listing to explain');
});

test('the human list puts those warnings on stdout with the listing', async () => {
  const { text, err } = await listWith(['list'], STATE_MANIFEST);
  assert.equal(err, '');
  assert.ok(text.includes("Listing 'code-review' without unknown target(s): zed"));
  assert.ok(!text.includes('other-sdk'));
});

/**
 * A marketplace that cannot be read is a failure, not an empty listing: an
 * empty grid would read as "this marketplace offers nothing", which is a
 * different and wrong answer.
 */
test('a registry that cannot be read fails, naming what to check', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = stubFetch({}) as unknown as typeof globalThis.fetch;
  try {
    const { code, err, text } = await runCli(['list'], STATE_MANIFEST, { CP_REPO: REPO });
    assert.equal(code, 1);
    assert.ok(err.includes('Could not read'), err);
    // `log.error` goes to stderr and its hint to stdout, as every other failure does.
    assert.ok(text.includes('--repo'), `the hint names the flags to check, got: ${text}`);
  } finally {
    globalThis.fetch = saved;
  }
});
