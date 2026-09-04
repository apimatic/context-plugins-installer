import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  UserError,
  assertPlugin,
  assertRepo,
  assertRef,
  copyDir,
  replaceDir,
  countFiles,
  which,
  pool,
  timestamp,
  stripBom,
  shortPath,
  suggest,
} from '../src/util.js';
import { tmpDir, cleanupAll } from './helpers.js';

test.after(cleanupAll);

// The rules themselves live with the identifier types, in test/types/ids. What
// is left here is the wrapper: a rejected value becomes a UserError carrying the
// message and hint the type wrote, which is what the CLI prints.
test('a valid identifier passes straight through the assert wrappers', () => {
  assert.equal(assertPlugin('acme-payments-sdk'), 'acme-payments-sdk');
  assert.equal(
    assertRepo('context-plugins/plugin-marketplace'),
    'context-plugins/plugin-marketplace',
  );
  assert.equal(assertRef('release/2024-06'), 'release/2024-06');
});

test('a rejected identifier throws a UserError carrying the hint its type wrote', () => {
  assert.throws(
    () => assertPlugin('Has-Caps'),
    (err) =>
      err instanceof UserError &&
      err.message === 'Invalid plugin id: "Has-Caps"' &&
      err.hint === 'Expected kebab-case, e.g. acme-payments',
  );
  assert.throws(
    () => assertRepo('a/b/c'),
    (err) =>
      err instanceof UserError && err.hint === 'Expected owner/repo, e.g. acme/plugin-marketplace',
  );
  assert.throws(
    () => assertRef('--upload-pack=x'),
    (err) =>
      err instanceof UserError && err.hint === 'Expected a branch, tag, or commit sha, e.g. main',
  );
});

test('copyDir reproduces a nested tree', () => {
  const src = tmpDir('cp-src-');
  fs.mkdirSync(path.join(src, 'skills', 'dotnet'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plugin.json'), '{}');
  fs.writeFileSync(path.join(src, 'skills', 'dotnet', 'SKILL.md'), '# skill');

  const dest = path.join(tmpDir('cp-dest-'), 'out');
  copyDir(src, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'skills', 'dotnet', 'SKILL.md'), 'utf8'), '# skill');
  assert.equal(countFiles(dest), 2);
});

test('replaceDir does not leave files behind from a previous version', () => {
  const dest = path.join(tmpDir('cp-dest-'), 'out');
  const v1 = tmpDir('cp-v1-');
  fs.writeFileSync(path.join(v1, 'old.md'), 'old');
  copyDir(v1, dest);

  const v2 = tmpDir('cp-v2-');
  fs.writeFileSync(path.join(v2, 'new.md'), 'new');
  replaceDir(v2, dest);

  assert.deepEqual(fs.readdirSync(dest), ['new.md']);
});

test('which finds node and misses nonsense', () => {
  assert.ok(which('node'), 'node should be on PATH while running tests');
  assert.equal(which('definitely-not-a-real-binary-xyz'), null);
});

test('pool preserves input order regardless of completion order', async () => {
  const items = [30, 5, 20, 1, 10];
  const results = await pool(items, 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(results, items);
});

test('timestamp matches the PowerShell backup suffix format', () => {
  assert.equal(timestamp(new Date(2026, 6, 27, 9, 5, 3)), '20260727-090503');
});

test('shortPath collapses the home directory to ~', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const inside = path.join(home, '.cursor', 'plugins');
  assert.equal(shortPath(inside, home), `~${path.sep}.cursor${path.sep}plugins`);
  assert.equal(shortPath(path.join('/elsewhere', 'x'), home), path.join('/elsewhere', 'x'));
});

test('suggest finds a near miss even when a shared suffix inflates the distance', () => {
  const names = ['azure-cognitive-sdk', 'docker-sdk', 'vimeo-sdk'];
  assert.deepEqual(suggest('azure-cognitve', names), ['azure-cognitive-sdk']);
  assert.deepEqual(suggest('docker', names), ['docker-sdk']);
  assert.deepEqual(suggest('zzzzzzzzzzzzzzzz', names), []);
});

test('stripBom only removes a leading BOM', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(stripBom(`${bom}{}`), '{}');
  assert.equal(stripBom('{}'), '{}');
});
