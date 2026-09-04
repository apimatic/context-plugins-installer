import test from 'node:test';
import assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { run, which } from '../../src/infrastructure/process-runner.js';
import { tmpDir, cleanupAll } from '../helpers.js';

const EOL = String.fromCharCode(13) + String.fromCharCode(10);

test.after(cleanupAll);

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

/**
 * The one part of `run()` CLAUDE.md names a hard constraint, and it had no
 * coverage at all: Node refuses to spawn a `.cmd` directly since the
 * CVE-2024-27980 hardening, so those go through cmd.exe with an explicitly
 * quoted command line. Every npm-installed CLI on Windows is a `.cmd` shim,
 * which is how this program reaches `claude`. Reordering the cmd.exe flags or
 * touching the quoting passes the whole matrix and breaks only real Windows
 * users, possibly as a mis-parsed argument rather than a crash.
 *
 * Windows only: the branch is unreachable anywhere else.
 */
test(
  'arguments survive the cmd.exe route intact, spaces and shell characters included',
  { skip: process.platform !== 'win32' ? 'the cmd.exe branch is Windows only' : false },
  async () => {
    const dir = tmpDir('cp-cmd-');
    const echoArgs = path.join(dir, 'echo-args.js');
    const script = 'console.log(JSON.stringify(process.argv.slice(2)));';
    fs.writeFileSync(echoArgs, script + EOL);
    const shim = path.join(dir, 'shim.cmd');
    fs.writeFileSync(shim, ['@echo off', 'node "%~dp0echo-args.js" %*', ''].join(EOL));

    const args = ['plugin', 'install', 'has space', 'a&b', 'quote"inside', 'semi;colon'];
    const result = await run(shim, args);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  },
);
