import test from 'node:test';
import assert from 'node:assert';

import { chooseTargets, resolveTargets } from '../../src/application/target-selection.js';
import { NAMES } from '../../src/types/harness.js';

test('targets resolve to canonical order, and all/empty means every harness', () => {
  assert.deepEqual(resolveTargets(null), { ok: true, value: [...NAMES] });
  assert.deepEqual(resolveTargets([]), { ok: true, value: [...NAMES] });
  assert.deepEqual(resolveTargets(['all']), { ok: true, value: [...NAMES] });
  assert.deepEqual(resolveTargets(['vscode', 'claude']), { ok: true, value: ['claude', 'vscode'] });
});

test('an unknown target names the valid ones', () => {
  const result = resolveTargets(['emacs']);
  assert.ok(!result.ok);
  assert.match(result.error.message, /Unknown target\(s\): emacs/);
  assert.match(result.error.hint ?? '', /claude, cursor, vscode/);
});

// `all` is a decision, so one bad name beside it is still a typo worth naming
// rather than something to widen past. It used to widen: `all` was read before
// the names were checked, so the typo was accepted in silence.
test('an unknown target is refused even alongside all', () => {
  const result = resolveTargets(['all', 'emacs']);
  assert.ok(!result.ok);
  assert.match(result.error.message, /Unknown target\(s\): emacs/);
  assert.deepEqual(resolveTargets(['all', 'cursor']), { ok: true, value: [...NAMES] });
  assert.equal(resolveTargets(['cursor', 'emacs']).ok, false);
});

const facts = (over: Record<string, unknown> = {}) => ({
  detected: 2,
  explicit: false,
  assumeYes: false,
  canAsk: true,
  ...over,
});

test('the user is asked only when there is a choice left and someone to answer', () => {
  assert.equal(chooseTargets(facts()), 'ask');
  assert.equal(chooseTargets(facts({ explicit: true })), 'take-all', '--targets already answered');
  assert.equal(chooseTargets(facts({ assumeYes: true })), 'take-all', '--yes opted out');
  assert.equal(chooseTargets(facts({ detected: 0 })), 'take-all', 'nothing to ask about');
});

/**
 * The one case that is not "already answered": nobody could be asked, so every
 * detected editor is taken rather than the run hanging - and that is worth
 * saying out loud, which is why it is its own answer and not `take-all`.
 */
test('with nobody to ask, taking every editor is distinguishable from being told to', () => {
  assert.equal(chooseTargets(facts({ canAsk: false })), 'cannot-ask');
  assert.equal(
    chooseTargets(facts({ canAsk: false, assumeYes: true })),
    'take-all',
    'being told beats having nobody to ask',
  );
});
