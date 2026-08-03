'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createTelemetry, classifyError, ENDPOINT } = require('../src/telemetry');
const paths = require('../src/paths');
const { UserError } = require('../src/util');
const { tmpDir, cleanupAll } = require('./helpers');

test.after(cleanupAll);

/** A sandboxed state directory, so no test touches the real one. */
function sandbox(env = {}) {
  const root = tmpDir('cp-telemetry-');
  return {
    root,
    pathOpts: { env: { CP_STATE_DIR: path.join(root, 'state'), ...env }, home: root },
  };
}

/** Captures posts instead of making them. */
function postSpy() {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  impl.calls = calls;
  return impl;
}

const TOKEN_ENV = { CP_MIXPANEL_TOKEN: 'test-token' };

test('no token means no telemetry, and no state written', async () => {
  const s = sandbox();
  const telemetry = createTelemetry({ pathOpts: s.pathOpts, env: {} });

  assert.equal(telemetry.enabled, false);
  telemetry.track('Install', { plugin: 'my-sdk' });
  await telemetry.flush();

  assert.ok(!fs.existsSync(paths.telemetryIdPath(s.pathOpts)), 'no id file for a disabled client');
});

test('DO_NOT_TRACK turns it off even with a token', () => {
  const s = sandbox();
  const telemetry = createTelemetry({
    pathOpts: s.pathOpts,
    env: { ...TOKEN_ENV, DO_NOT_TRACK: '1' },
  });
  assert.equal(telemetry.enabled, false);
});

test('CP_TELEMETRY=0 turns it off', () => {
  const s = sandbox();
  for (const value of ['0', 'false']) {
    const telemetry = createTelemetry({
      pathOpts: s.pathOpts,
      env: { ...TOKEN_ENV, CP_TELEMETRY: value },
    });
    assert.equal(telemetry.enabled, false, `CP_TELEMETRY=${value}`);
  }
});

test('an event carries the token, the machine id, and the environment', async () => {
  const s = sandbox();
  const post = postSpy();
  const telemetry = createTelemetry({
    pathOpts: s.pathOpts,
    env: { ...TOKEN_ENV, CI: '1', GITHUB_TOKEN: 'ghp_secret' },
    fetchImpl: post,
  });

  telemetry.track('Install', { plugin: 'my-sdk', outcome: 'success' });
  await telemetry.flush();

  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].url, ENDPOINT);
  assert.equal(post.calls[0].options.method, 'POST');

  const [payload] = JSON.parse(post.calls[0].options.body);
  assert.equal(payload.event, 'Install');
  assert.equal(payload.properties.token, 'test-token');
  assert.equal(payload.properties.plugin, 'my-sdk');
  assert.equal(payload.properties.is_ci, true);
  assert.equal(payload.properties.github_token_present, true);
  assert.equal(payload.properties.os_platform, process.platform);
  assert.equal(payload.properties.node_version, process.versions.node);
  assert.ok(payload.properties.distinct_id, 'anonymous id present');
  assert.ok(payload.properties.$insert_id, 'dedup key present');

  assert.ok(
    !JSON.stringify(payload).includes('ghp_secret'),
    'the GitHub token itself must never be sent',
  );
});

test('the machine id is stable across runs', async () => {
  const s = sandbox();
  const post = postSpy();
  const args = { pathOpts: s.pathOpts, env: TOKEN_ENV, fetchImpl: post };

  createTelemetry(args).track('Install', {});
  createTelemetry(args).track('Install', {});

  const ids = post.calls.map((c) => JSON.parse(c.options.body)[0].properties.distinct_id);
  assert.equal(ids[0], ids[1]);
  assert.equal(fs.readFileSync(paths.telemetryIdPath(s.pathOpts), 'utf8').trim(), ids[0]);
});

test('a refused request is swallowed', async () => {
  const s = sandbox();
  const telemetry = createTelemetry({
    pathOpts: s.pathOpts,
    env: TOKEN_ENV,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });

  telemetry.track('Install', { plugin: 'my-sdk' });
  await telemetry.flush(); // must not reject
});

test('errors map to a stable code, never their message', () => {
  const cases = [
    ["'my-sdk' is already installed from a different marketplace.", 'force_needed'],
    ['Cursor is not installed on this machine.', 'no_editor_detected'],
    ['No supported editor found on this machine.', 'no_editor_detected'],
    ["Claude Code already has a marketplace named 'x', from a/b rather than c/d.", 'marketplace_name_clash'],
    ["Plugin 'my-sdk' is not listed in Context Plugins Marketplace.", 'plugin_not_found'],
    ["Marketplace name 'Not Valid' is not a valid identifier.", 'invalid_marketplace_name'],
    ["Plugin 'x' is hosted in another repository (source type 'github').", 'plugin_in_other_repo'],
    ['GET https://example.com/x returned 403 rate limit exceeded', 'github_rate_limit'],
    ['GitHub API request failed (500 Server Error).', 'github_api_failed'],
    ['Could not reach api.github.com: connect ETIMEDOUT', 'network_unreachable'],
    ['git clone https://github.com/a/b.git failed (exit 128).', 'git_failed'],
    ["Plugin folder 'plugins/x' is empty or missing in a/b@main.", 'plugin_folder_empty'],
    ['claude plugin install x@y failed (exit 1).', 'claude_install_failed'],
    ['Invalid plugin id: "Not Kebab"', 'invalid_argument'],
    ['Something nobody has named yet', 'other'],
  ];

  for (const [message, expected] of cases) {
    assert.equal(classifyError(new UserError(message)), expected, message);
  }
});

test('a crash is told apart from a known failure', () => {
  assert.equal(classifyError(new TypeError('x is not a function')), 'unexpected');
  assert.equal(classifyError(new UserError('Something nobody has named yet')), 'other');
  assert.equal(classifyError(undefined), 'unexpected');
});
