import test from 'node:test';
import assert from 'node:assert';

import { run, which } from '../../src/infrastructure/process-runner.js';

test('which finds node and misses nonsense', () => {
  assert.ok(which('node'), 'node should be on PATH while running tests');
  assert.equal(which('definitely-not-a-real-binary-xyz'), null);
});

// The runner is the seam every harness spawns through, so what it reports back
// about a process is worth pinning: a non-zero exit is a result, not a throw.
test('a command that fails reports its code rather than throwing', async () => {
  const node = which('node');
  assert.ok(node, 'node should be on PATH while running tests');
  const result = await run(node, ['-e', 'process.exit(3)']);
  assert.equal(result.code, 3);
});

test('stdout and stderr come back separately', async () => {
  const node = which('node');
  assert.ok(node, 'node should be on PATH while running tests');
  const result = await run(node, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err")',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

// A missing binary is the one case that rejects rather than resolving, because
// nothing ran and there is no exit code to report.
test('a binary that does not exist rejects', async () => {
  await assert.rejects(() => run('definitely-not-a-real-binary-xyz', []));
});
