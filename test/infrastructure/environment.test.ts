import test from 'node:test';
import assert from 'node:assert';

import { isCi, isInteractive, packageVersion } from '../../src/infrastructure/environment.js';

test('CI and CP_NO_INPUT both force non-interactive', () => {
  assert.equal(isInteractive({ CI: '1' }), false);
  assert.equal(isInteractive({ CP_NO_INPUT: '1' }), false);
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
