import test from 'node:test';
import assert from 'node:assert';

import { Failure } from '../../src/types/failure.js';
import { err, ok, type Result } from '../../src/types/result.js';

test('ok carries the value', () => {
  assert.deepEqual(ok(42), { ok: true, value: 42 });
});

test('err carries the error', () => {
  const failure = new Failure('no');
  assert.deepEqual(err(failure), { ok: false, error: failure });
});

// The point of the shape: `ok` is the discriminant, so one check reaches the
// value with no cast. This compiling is most of the assertion.
test('checking ok narrows to the value, and its absence to the error', () => {
  const results: Result<number>[] = [ok(1), err(new Failure('bad'))];
  const seen: string[] = [];
  for (const result of results) {
    seen.push(result.ok ? `value ${result.value}` : `error ${result.error.message}`);
  }
  assert.deepEqual(seen, ['value 1', 'error bad']);
});

test('a result with nothing to carry is still a success', () => {
  const result: Result<void> = ok(undefined);
  assert.equal(result.ok, true);
});

test('the error type defaults to Failure but accepts another', () => {
  const coded: Result<never, 'ENOENT'> = err('ENOENT');
  assert.deepEqual(coded, { ok: false, error: 'ENOENT' });
});
