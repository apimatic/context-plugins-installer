import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBrand } from '../src/brand.js';
import { rawUrl } from '../src/catalog.js';
import { diagnose } from '../src/doctor.js';
import * as paths from '../src/paths.js';
import type { DoctorCheck, DoctorReport } from '../src/types/doctor.js';
import type { Env } from '../src/types/env.js';
import type { Deps } from '../src/types/ports.js';
import { tmpDir, cleanupAll, stubFetch } from './helpers.js';

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

function deps({ name = 'context-plugins', git = true, env = {} as Env } = {}): Deps {
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

/** The check with this label; a report that lacks one is itself a test failure. */
function find(report: DoctorReport, label: string): DoctorCheck {
  const check = report.groups.flatMap((g) => g.checks).find((c) => c.label === label);
  if (!check) throw new Error(`no '${label}' check in ${JSON.stringify(report.groups)}`);
  return check;
}

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
  assert.match(find(report, 'git').hint ?? '', /rate limited/);
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
  assert.match(registryCheck.hint ?? '', /kebab-case/);
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

test('doctor reports rows installed.json holds that this build cannot read', async () => {
  const m = machine();
  const file = paths.manifestPath(m.pathOpts).toString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'future-sdk', repo: REPO, targets: ['zed'] }],
    }),
  );

  const report = await diagnose({ brand: brand(), deps: deps(), ...m });
  const check = find(report, 'Installed');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /1 entry ignored/);
  assert.match(check.hint ?? '', /unknown target\(s\): zed/);
});

test('doctor reports a row it can only read in part, rather than calling it healthy', async () => {
  const m = machine();
  const file = paths.manifestPath(m.pathOpts).toString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [{ plugin: 'code-review', repo: REPO, targets: ['vscode', 'zed'] }],
    }),
  );

  const report = await diagnose({ brand: brand(), deps: deps(), ...m });
  const check = find(report, 'Installed');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /1 plugin; 1 listed in part/);
  assert.match(
    check.hint ?? '',
    /'code-review' records target\(s\) this build does not know \(zed\)/,
  );
});

test('doctor names the telemetry switch in effect, and never counts it against the machine', async () => {
  const on = await diagnose({ brand: brand(), deps: deps(), ...machine() });
  assert.equal(find(on, 'Telemetry').status, 'ok');
  assert.equal(find(on, 'Telemetry').detail, 'enabled');

  const off = await diagnose({
    brand: brand(),
    deps: deps({ env: { DO_NOT_TRACK: '1' } }),
    ...machine(),
  });
  assert.equal(find(off, 'Telemetry').status, 'ok');
  assert.equal(find(off, 'Telemetry').detail, 'disabled (DO_NOT_TRACK)');
  assert.equal(off.warnings, on.warnings, 'opting out adds no warning');
});
