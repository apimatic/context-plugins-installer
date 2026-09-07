import test from 'node:test';
import assert from 'node:assert';

import { runCli } from '../cli-harness.js';
import { cleanupAll } from '../helpers.js';

test.after(cleanupAll);

// `installed` end to end, through the real entry point: what the action decided
// (test/actions/installed.test.ts) as the user actually reads it.

const REPO = 'context-plugins/plugin-marketplace';

// `installed --targets vscode` used to answer exactly as though the flag were
// absent: accepted, ignored, no signal.
const PER_EDITOR = {
  version: 1,
  plugins: [
    { plugin: 'only-cursor', repo: REPO, marketplace: 'apimatic', targets: ['cursor'] },
    { plugin: 'only-vscode', repo: REPO, marketplace: 'apimatic', targets: ['vscode'] },
    { plugin: 'both', repo: REPO, marketplace: 'apimatic', targets: ['cursor', 'vscode'] },
  ],
};

const STATE_MANIFEST = {
  version: 1,
  plugins: [
    { plugin: 'my-sdk', repo: REPO, targets: ['claude'] },
    // Half readable: listed, but one target belongs to a build that is not this one.
    { plugin: 'code-review', repo: REPO, targets: ['vscode', 'zed'] },
    { plugin: 'future-sdk', repo: REPO, targets: ['zed'] },
    // Another marketplace entirely, so the scope rules can be told apart.
    { plugin: 'other-sdk', repo: 'acme/marketplace', targets: ['zed'] },
  ],
};

test('installed --targets lists only what is recorded for those editors', async () => {
  const { code, text } = await runCli(['installed', '--targets', 'vscode'], PER_EDITOR);

  assert.equal(code, 0);
  assert.ok(text.includes('only-vscode'));
  assert.ok(text.includes('both'), 'a plugin in several editors still counts');
  assert.ok(!text.includes('only-cursor'), 'and one in none of them does not');
  assert.ok(text.includes('2 plugins installed in VS Code'), 'the heading says what it filtered');
});

test('installed --targets filters the --json payload the same way', async () => {
  const { out } = await runCli(['installed', '--targets', 'cursor', '--json'], PER_EDITOR);
  const payload: { plugin: string }[] = JSON.parse(out);

  assert.deepEqual(
    payload.map((e) => e.plugin).sort(),
    ['both', 'only-cursor'],
    'the payload is the filtered rows, in the same shape as before',
  );
});

test('installed --targets still shows every editor a listed plugin is recorded for', async () => {
  const { text } = await runCli(['installed', '--targets', 'vscode'], PER_EDITOR);
  // The filter chooses the rows; it does not narrow what each row says.
  assert.ok(text.includes('both Cursor, VS Code'), text);
});

test('installed --targets with no match says so, rather than "none yet"', async () => {
  const { text } = await runCli(['installed', '--targets', 'claude'], PER_EDITOR);
  assert.ok(text.includes('No plugins installed in Claude Code.'), text);
});

test('installed --targets all is the same as not asking', async () => {
  const every = await runCli(['installed', '--targets', 'all'], PER_EDITOR);
  const plain = await runCli(['installed'], PER_EDITOR);
  assert.equal(every.text, plain.text);
});

test('an unknown --targets value is refused, not quietly dropped', async () => {
  const { code, err } = await runCli(['installed', '--targets', 'emacs'], PER_EDITOR);
  assert.equal(code, 1);
  assert.ok(err.includes('Unknown target(s): emacs'), err);
});

test('installed --json leaves stdout to the payload and puts the warnings on stderr', async () => {
  const { code, out, err } = await runCli(['installed', '--json'], STATE_MANIFEST);
  assert.equal(code, 0);

  const payload: { plugin: string; targets: string[] }[] = JSON.parse(out);
  assert.deepEqual(
    payload.map((e) => e.plugin),
    ['my-sdk', 'code-review'],
    'stdout parses on its own - no warning line reached it',
  );
  assert.deepEqual(payload[1]?.targets, ['vscode'], 'the row is listed without the zed target');
  assert.ok(
    err.includes(`Ignoring 'future-sdk' (${REPO}) in installed.json - unknown target(s): zed.`),
    `the dropped row is named on stderr, got: ${err}`,
  );
  assert.ok(
    err.includes(
      `Listing 'code-review' (${REPO}) without unknown target(s): zed - the entry on disk`,
    ),
    `so is the target the listed row lost, got: ${err}`,
  );
});

test('the human listing warns about the same gaps, on stdout', async () => {
  const { text, err } = await runCli(['installed'], STATE_MANIFEST);
  assert.equal(err, '', 'without --json there is no payload to keep clean');
  assert.ok(text.includes(`Ignoring 'future-sdk' (${REPO}) in installed.json`));
  assert.ok(text.includes(`Listing 'code-review' (${REPO}) without unknown target(s): zed`));
});

test('--quiet silences the warnings, never the payload --json was run for', async () => {
  const { code, out, err } = await runCli(['installed', '--json', '--quiet'], STATE_MANIFEST);
  assert.equal(code, 0);
  const payload: { plugin: string }[] = JSON.parse(out);
  assert.deepEqual(
    payload.map((e) => e.plugin),
    ['my-sdk', 'code-review'],
  );
  assert.equal(err, '', 'the warnings are what --quiet is for');
});

/**
 * Every gap is scoped to one marketplace by `list` and to none by `installed`,
 * which is why both kinds carry a repo. Here the other marketplace's row must
 * still be reported, with its repo named so the label says which file entry.
 */
test('installed reports gaps from every marketplace, each naming its repo', async () => {
  const { text } = await runCli(['installed'], STATE_MANIFEST);
  assert.ok(text.includes(`Ignoring 'other-sdk' (acme/marketplace) in installed.json`), text);
});
