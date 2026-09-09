import test from 'node:test';
import assert from 'node:assert';

import { ActionResult } from '../../src/actions/action-result.js';
import { Failure } from '../../src/types/failure.js';

interface Report {
  plugin: string;
  installed: string[];
}

const report: Report = { plugin: 'my-sdk', installed: ['cursor'] };

test('a success carries its report and exits 0', () => {
  const result = ActionResult.success(report);
  assert.equal(result.isSuccess(), true);
  assert.equal(result.isFailed(), false);
  assert.equal(result.isCancelled(), false);
  assert.equal(result.exitCode(), 0);
  assert.deepEqual(result.report, report);
  assert.equal(result.failure, null);
});

test('a failure carries the reason and exits 1', () => {
  const failure = new Failure('Could not uninstall.', 'Close the editor and try again.');
  const result = ActionResult.failed(report, failure);
  assert.equal(result.isFailed(), true);
  assert.equal(result.isSuccess(), false);
  assert.equal(result.exitCode(), 1);
  assert.equal(result.failure, failure);
});

test('a cancellation exits 130, the shell convention for an interrupted run', () => {
  const result = ActionResult.cancelled(report);
  assert.equal(result.isCancelled(), true);
  assert.equal(result.exitCode(), 130);
  assert.equal(result.failure, null);
});

/**
 * The reason all three variants carry a report: the command fires telemetry from
 * the facts of the run, and a run that failed part-way still installed whatever
 * it installed before it stopped.
 */
test('a failed run still reports what it managed to do', () => {
  const partial: Report = { plugin: 'my-sdk', installed: ['cursor'] };
  const result = ActionResult.failed(partial, new Failure('VS Code went wrong'));
  assert.deepEqual(result.report.installed, ['cursor']);
});

test('a cancelled run reports too, so nothing has to guess what was reached', () => {
  assert.deepEqual(ActionResult.cancelled(report).report, report);
});
