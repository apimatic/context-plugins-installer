'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { diagnose } = require('../src/doctor');
const { resolveBrand } = require('../src/brand');
const { rawUrl } = require('../src/catalog');
const { tmpDir, cleanupAll, stubFetch } = require('./helpers');

test.after(cleanupAll);

const REPO = 'context-plugins/plugin-marketplace';
const brand = () =>
  resolveBrand({ env: { CP_REPO: REPO }, cwd: tmpDir('cp-cwd-'), home: tmpDir('cp-home-') });

/** A machine with both file-based editors present, and no `claude` on PATH. */
function machine({ cursor = true, vscode = true } = {}) {
  const root = tmpDir('cp-doctor-');
  const env = {
    CP_STATE_DIR: path.join(root, 'state'),
    CP_CURSOR_DIR: path.join(root, '.cursor'),
    CP_VSCODE_USER_DIR: path.join(root, 'code-user'),
  };
  if (cursor) fs.mkdirSync(env.CP_CURSOR_DIR, { recursive: true });
  if (vscode) fs.mkdirSync(env.CP_VSCODE_USER_DIR, { recursive: true });
  return { pathOpts: { env, home: root } };
}

const registry = (name = 'context-plugins') => ({
  name,
  plugins: [{ name: 'my-sdk', source: './plugins/my-sdk' }],
});

function deps({ name = 'context-plugins', git = true, env = {} } = {}) {
  return {
    env,
    which: (cmd) => (cmd === 'git' && git ? '/usr/bin/git' : null),
    run: async () => ({ code: 0, stdout: 'git version 2.43.0', stderr: '' }),
    fetchImpl: stubFetch({
      [rawUrl(REPO, 'main', '.claude-plugin/marketplace.json')]: { body: registry(name) },
      'https://api.github.com/rate_limit': {
        body: { resources: { core: { limit: 60, remaining: 59 } } },
      },
    }),
  };
}

const find = (report, label) =>
  report.groups.flatMap((g) => g.checks).find((c) => c.label === label);

test('a healthy machine reports ok', async () => {
  const report = await diagnose({ brand: brand(), deps: deps(), ...machine() });
  assert.equal(report.ok, true);
  assert.equal(report.failures, 0);
  assert.equal(find(report, 'Registry').detail, 'context-plugins, 1 plugins');
  assert.equal(find(report, 'State directory').status, 'ok');
});

test('no editor at all is a failure, not a warning', async () => {
  const report = await diagnose({
    brand: brand(),
    deps: deps(),
    ...machine({ cursor: false, vscode: false }),
  });
  assert.equal(report.ok, false);
  assert.equal(find(report, 'Any editor').status, 'fail');
  assert.match(find(report, 'Cursor').detail, /not installed \(looked in /);
});

test('one editor present is enough to pass', async () => {
  const report = await diagnose({
    brand: brand(),
    deps: deps(),
    ...machine({ cursor: false, vscode: true }),
  });
  assert.equal(report.ok, true);
  assert.equal(find(report, 'Cursor').status, 'warn');
  assert.equal(find(report, 'VS Code').status, 'ok');
});

test('a missing git is a warning, since the API path still works', async () => {
  const report = await diagnose({ brand: brand(), deps: deps({ git: false }), ...machine() });
  assert.equal(report.ok, true);
  assert.equal(find(report, 'git').status, 'warn');
  assert.match(find(report, 'git').hint, /rate limited/);
});

test('an invalid marketplace name is reported as a failure', async () => {
  const report = await diagnose({
    brand: brand(),
    deps: deps({ name: 'Context Plugins' }),
    ...machine(),
  });
  assert.equal(report.ok, false);
  const registryCheck = find(report, 'Registry');
  assert.equal(registryCheck.status, 'fail');
  assert.match(registryCheck.hint, /kebab-case/);
});

test('a configured proxy is surfaced, because Node ignores it', async () => {
  const report = await diagnose({
    brand: brand(),
    deps: deps({ env: { HTTPS_PROXY: 'http://proxy:8080' } }),
    ...machine(),
  });
  assert.equal(find(report, 'Proxy').status, 'warn');
  assert.equal(report.ok, true, 'a proxy is a warning, not a hard failure');
});

test('an unreachable marketplace fails without throwing', async () => {
  const report = await diagnose({
    brand: brand(),
    deps: {
      env: {},
      which: () => '/usr/bin/git',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    },
    ...machine(),
  });
  assert.equal(report.ok, false);
  assert.equal(find(report, 'Reachable').status, 'fail');
});
