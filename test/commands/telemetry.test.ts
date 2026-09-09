import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCli } from '../cli-harness.js';
import { cleanupAll, tmpDir } from '../helpers.js';

test.after(cleanupAll);

// `telemetry` end to end, through the real entry point. The action's decisions
// are in test/actions/telemetry.test.ts; these are the words and the file.

const NO_PLUGINS = { version: 1, plugins: [] };

test('telemetry disable and enable round-trip through the state file, and status names the switch in effect', async () => {
  const root = tmpDir('cp-telemetry-cli-');
  const env = { CP_TELEMETRY: 'on' };

  const off = await runCli(['telemetry', 'disable'], NO_PLUGINS, env, root);
  assert.equal(off.code, 0);
  assert.ok(off.text.includes('Telemetry disabled.'), off.text);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'telemetry.json'), 'utf8'));
  assert.equal(state.enabled, false);

  const status = await runCli(['telemetry', 'status'], NO_PLUGINS, env, root);
  assert.ok(
    status.text.includes('Telemetry is disabled (context-plugins telemetry disable).'),
    status.text,
  );
  assert.ok(status.text.includes(`Anonymous machine id: ${state.id}`));

  const on = await runCli(['telemetry', 'enable'], NO_PLUGINS, env, root);
  assert.ok(on.text.includes('Telemetry enabled.'), on.text);
  const after = await runCli(['telemetry'], NO_PLUGINS, env, root);
  assert.ok(after.text.includes('Telemetry is enabled.'), after.text);

  const dnt = await runCli(
    ['telemetry', 'enable'],
    NO_PLUGINS,
    { ...env, DO_NOT_TRACK: '1' },
    root,
  );
  assert.ok(
    dnt.text.includes('disabled (DO_NOT_TRACK)'),
    `a broader switch is named when it overrides the saved choice, got: ${dnt.text}`,
  );

  const bad = await runCli(['telemetry', 'frobnicate'], NO_PLUGINS, env, root);
  assert.equal(bad.code, 1);
  assert.ok(bad.err.includes('Unknown telemetry action: frobnicate'), bad.err);
});

test('telemetry disable under CP_TELEMETRY=log says the log mode still wins', async () => {
  const { code, text } = await runCli(['telemetry', 'disable'], NO_PLUGINS, {
    CP_TELEMETRY: 'log',
  });
  assert.equal(code, 0);
  assert.ok(text.includes('Telemetry disabled.'), text);
  assert.ok(text.includes('Right now it is log only (CP_TELEMETRY=log)'), text);
});

/**
 * The id file is minted by a run that actually tracks something, so a command
 * that only reads must leave the state directory as it found it - otherwise
 * `installed` would opt a user in by being run.
 */
test('the read-only commands never touch telemetry.json', async () => {
  const { code, root } = await runCli(['installed'], NO_PLUGINS, { CP_TELEMETRY: 'on' });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(root, 'state', 'telemetry.json')), false);
});
