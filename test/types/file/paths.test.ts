import test from 'node:test';
import assert from 'node:assert';

import { DirectoryPath, FilePath, rulesFor } from '../../../src/types/file/paths.js';

const WIN = rulesFor('win32');
const POSIX = rulesFor('linux');

// The whole reason a path carries its own rules: the platform a path belongs to
// is not always the one we are running on, and this suite has to assert both
// from whichever runner it lands on.
test('a path joins by the rules of its own platform, not the host', () => {
  assert.equal(
    new DirectoryPath('C:\\Users\\dev', WIN).join('.cursor', 'plugins').toString(),
    'C:\\Users\\dev\\.cursor\\plugins',
  );
  assert.equal(
    new DirectoryPath('/home/dev', POSIX).join('.cursor', 'plugins').toString(),
    '/home/dev/.cursor/plugins',
  );
});

test('a directory names a file inside it', () => {
  assert.equal(
    new DirectoryPath('/home/dev/.context-plugins', POSIX).file('installed.json').toString(),
    '/home/dev/.context-plugins/installed.json',
  );
  assert.equal(
    new DirectoryPath('C:\\state', WIN).file('installed.json').toString(),
    'C:\\state\\installed.json',
  );
});

test('a file names the directory holding it', () => {
  assert.equal(
    new FilePath('/home/dev/.context-plugins/installed.json', POSIX).parent().toString(),
    '/home/dev/.context-plugins',
  );
  assert.equal(new FilePath('C:\\state\\installed.json', WIN).parent().toString(), 'C:\\state');
});

test('the leaf and file names come from the same rules', () => {
  assert.equal(new DirectoryPath('/a/b/my-sdk', POSIX).leafName(), 'my-sdk');
  assert.equal(new DirectoryPath('C:\\a\\b\\my-sdk', WIN).leafName(), 'my-sdk');
  assert.equal(new FilePath('C:\\a\\settings.json', WIN).name(), 'settings.json');
});

test('a suffixed sibling keeps the directory and the rules', () => {
  const backup = new FilePath('C:\\code\\settings.json', WIN).withSuffix('.bak-20260904-101500');
  assert.equal(backup.toString(), 'C:\\code\\settings.json.bak-20260904-101500');
  assert.equal(backup.parent().toString(), 'C:\\code');
});

test('two paths spelled the same are equal', () => {
  assert.equal(new DirectoryPath('/a/b').isEqual(new DirectoryPath('/a/b')), true);
  assert.equal(new DirectoryPath('/a/b').isEqual(new DirectoryPath('/a/c')), false);
  assert.equal(new FilePath('/a/b.json').isEqual(new FilePath('/a/b.json')), true);
});

/**
 * This is the check that stops a remote tree entry naming a write outside the
 * checkout. The separator is the point: a prefix test alone would accept a
 * sibling directory whose name merely starts the same way.
 */
test('containment needs a separator, so a same-prefix sibling is outside', () => {
  const dest = new DirectoryPath('/tmp/work/files', POSIX);
  assert.equal(dest.contains(new FilePath('/tmp/work/files/skills/SKILL.md', POSIX)), true);
  assert.equal(dest.contains(dest), true, 'the directory itself is inside it');
  assert.equal(dest.contains(new FilePath('/tmp/work/files-elsewhere/x', POSIX)), false);
  assert.equal(dest.contains(new FilePath('/tmp/work/other/x', POSIX)), false);
  assert.equal(dest.contains(new FilePath('/tmp/work', POSIX)), false, 'the parent is not inside');
});

test('containment follows the target platform separator', () => {
  const dest = new DirectoryPath('C:\\work\\files', WIN);
  assert.equal(dest.contains(new FilePath('C:\\work\\files\\a.md', WIN)), true);
  assert.equal(dest.contains(new FilePath('C:\\work\\files-elsewhere\\a.md', WIN)), false);
});
