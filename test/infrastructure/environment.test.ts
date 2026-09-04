import test from 'node:test';
import assert from 'node:assert';

import { isCi, isInteractive, packageVersion } from '../../src/infrastructure/environment.js';

/**
 * The TTY state is described rather than read, because under a test runner
 * neither end is a terminal: without this the third clause answered false for
 * every environment, and both assertions passed with the guards deleted.
 */
const ATTACHED = { stdin: true, stdout: true };

test('a real terminal with nothing in the way is interactive', () => {
  assert.equal(isInteractive({}, ATTACHED), true);
});

test('CI and CP_NO_INPUT each force non-interactive on a real terminal', () => {
  assert.equal(isInteractive({ CI: '1' }, ATTACHED), false);
  assert.equal(isInteractive({ CP_NO_INPUT: '1' }, ATTACHED), false);
  assert.equal(isInteractive({ GITHUB_ACTIONS: 'true' }, ATTACHED), false);
});

test('either end detached is enough to rule out a prompt', () => {
  assert.equal(isInteractive({}, { stdin: true, stdout: false }), false);
  assert.equal(isInteractive({}, { stdin: false, stdout: true }), false);
});

test('CI is detected from the usual variables, and "false" is not CI', () => {
  assert.equal(isCi({}), false);
  assert.equal(isCi({ CI: 'true' }), true);
  assert.equal(isCi({ CI: '1' }), true);
  assert.equal(isCi({ CI: 'false' }), false);
  assert.equal(isCi({ GITHUB_ACTIONS: 'true' }), true);
});

// This moved a directory deeper than it used to sit, so the relative walk up to
// package.json changed with it. A wrong depth would report `unknown` from every
// `--version` and stamp that on every event.
test('the version is read from the real package.json, at the new depth', () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});
