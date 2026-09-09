import test from 'node:test';
import assert from 'node:assert';

import {
  NAMES,
  TITLES,
  everyEditor,
  isHarnessName,
  titlesOf,
  type HarnessName,
} from '../../src/types/harness.js';

// The vocabulary the whole program uses to talk about editors, one layer below
// the modules that install into them - which is what lets a pure decision name
// an editor. `TITLES` is the source: `NAMES` is derived from its keys and
// `isHarnessName` answers from them.

test('every name this build knows has a title, and NAMES is exactly those keys', () => {
  assert.deepEqual([...NAMES], Object.keys(TITLES));
  for (const name of NAMES) assert.equal(typeof TITLES[name], 'string');
});

test('a name is known only if it has a title', () => {
  for (const name of NAMES) assert.equal(isHarnessName(name), true);
  for (const other of ['zed', 'Claude', '', 'toString', null, 42, {}]) {
    assert.equal(isHarnessName(other), false, `expected ${String(other)} to be unknown`);
  }
});

/**
 * `isHarnessName` reads TITLES on every call while NAMES is taken once at load,
 * so a table left mutable could put the two out of step: a name this build
 * claims to know with no module behind it, which `rowShape` would then read as a
 * target list rather than as foreign.
 */
test('the title table cannot be added to at runtime', () => {
  const mutable = TITLES as Record<string, string>;
  assert.throws(() => {
    mutable.zed = 'Zed';
  }, TypeError);
  assert.equal(isHarnessName('zed'), false);
  assert.equal(NAMES.includes('zed' as HarnessName), false);
});

test('editor lists are prose, derived rather than written out', () => {
  assert.equal(titlesOf(NAMES), 'Claude Code, Cursor, VS Code');
  assert.equal(titlesOf(['vscode', 'claude']), 'VS Code, Claude Code', 'in the order given');
  assert.equal(titlesOf([]), '');
  assert.equal(everyEditor(), 'Claude Code / Cursor / VS Code');
  assert.equal(everyEditor('or'), 'Claude Code, Cursor, or VS Code');
  assert.equal(everyEditor('and'), 'Claude Code, Cursor, and VS Code');
});
