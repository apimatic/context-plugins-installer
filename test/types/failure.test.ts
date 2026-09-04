import test from 'node:test';
import assert from 'node:assert';

import { Failure } from '../../src/types/failure.js';

test('a failure carries the message the user reads', () => {
  const failure = new Failure('Plugin folder is empty.');
  assert.equal(failure.message, 'Plugin folder is empty.');
  assert.equal(failure.hint, undefined);
});

test('the hint is optional, and separate from the message', () => {
  const failure = new Failure('Could not reach github.com.', 'Check your network connection.');
  assert.equal(failure.message, 'Could not reach github.com.');
  assert.equal(failure.hint, 'Check your network connection.');
});

// A Failure is returned, never raised: a `catch` must not be what handles it.
test('a failure is not an error, so it cannot be thrown by accident', () => {
  assert.ok(!(new Failure('x') instanceof Error));
});
