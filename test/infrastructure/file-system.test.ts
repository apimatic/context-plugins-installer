import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { copyDir, countFiles, replaceDir } from '../../src/infrastructure/file-system.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import { tmpDir, cleanupAll } from '../helpers.js';

test.after(cleanupAll);

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

// The service is where a path stops being a value and becomes a string, so it
// has to take either form for as long as both are still in circulation.
test('a path value works wherever a string does', () => {
  const src = new DirectoryPath(tmpDir('cp-src-'));
  fs.writeFileSync(path.join(src.toString(), 'plugin.json'), '{}');
  const dest = new DirectoryPath(tmpDir('cp-dest-')).join('out');

  copyDir(src, dest);

  assert.equal(countFiles(dest), 1);
  assert.ok(fs.existsSync(path.join(dest.toString(), 'plugin.json')));
});

test('a repository that carried the plugin is not part of the plugin', () => {
  const src = tmpDir('cp-fs-src-');
  fs.mkdirSync(path.join(src, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(src, '.git', 'config'), '[remote "origin"]');
  fs.writeFileSync(path.join(src, '.git', 'objects', 'pack'), 'blob');
  fs.mkdirSync(path.join(src, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plugin.json'), '{}');
  fs.writeFileSync(path.join(src, 'skills', 'SKILL.md'), '# skill');

  const dest = path.join(tmpDir('cp-fs-dest-'), 'out');
  copyDir(src, dest);

  assert.ok(!fs.existsSync(path.join(dest, '.git')), 'no repository in the installed copy');
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'SKILL.md')));
  assert.equal(countFiles(src), 2, 'and it is not counted as the plugin either');
});

test('replaceDir refuses to copy a directory over itself', () => {
  // Without the check this is silent: `rmrf` takes the source away and the copy
  // reports success.
  const dir = tmpDir('cp-self-');
  fs.writeFileSync(path.join(dir, 'keep.md'), '# keep');

  assert.throws(() => replaceDir(dir, dir), /over itself/);
  assert.throws(() => replaceDir(dir, dir.toUpperCase()), /over itself/);
  assert.ok(fs.existsSync(path.join(dir, 'keep.md')), 'and nothing was deleted');
});
