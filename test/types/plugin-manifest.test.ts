import test from 'node:test';
import assert from 'node:assert';

import type { Failure } from '../../src/types/failure.js';
import { MANIFEST_FILES, readManifest } from '../../src/types/plugin-manifest.js';
import type { Result } from '../../src/types/result.js';

// The pure half of reading a plugin's own manifest. Which files are tried, and
// what happens when a directory has none, is
// test/infrastructure/local-plugin.test.ts - this is only what one manifest's
// bytes mean once they have been parsed.

const FROM = '.claude-plugin/plugin.json';

const failure = <T>(result: Result<T, Failure>): Failure => {
  assert.ok(!result.ok, 'expected a failure');
  return result.error;
};

test('the id, the description and the version are read', () => {
  const read = readManifest({ name: 'my-sdk', description: 'A plugin', version: '1.2.3' }, FROM);
  assert.ok(read.ok, read.ok ? '' : read.error.message);
  assert.equal(read.value.id.toString(), 'my-sdk');
  assert.equal(read.value.description, 'A plugin');
  assert.equal(read.value.version, '1.2.3');
});

test('a description and a version are optional, and absent means null or empty', () => {
  const read = readManifest({ name: 'my-sdk' }, FROM);
  assert.ok(read.ok);
  assert.equal(read.value.description, '');
  assert.equal(read.value.version, null, 'a plugin need not declare one');
});

test('fields of the wrong type read as absent rather than being carried through', () => {
  const read = readManifest({ name: 'my-sdk', description: 42, version: ['1.0'] }, FROM);
  assert.ok(read.ok);
  assert.equal(read.value.description, '');
  assert.equal(read.value.version, null);
});

test('an unusable name names the file and the value it found', () => {
  // The id is load-bearing three times over - the destination folder, half the
  // manifest key, and the left half of `<plugin>@<marketplace>` - so a name
  // this build cannot accept has to say which file it came from.
  const err = failure(readManifest({ name: 'My Plugin' }, FROM));
  assert.match(err.message, /\.claude-plugin\/plugin\.json/);
  assert.match(err.message, /"My Plugin"/);
  assert.match(err.hint ?? '', /kebab-case/);
});

test('a missing name says so rather than quoting nothing', () => {
  for (const data of [{}, { name: '' }, { name: 42 }, { description: 'only this' }]) {
    assert.match(failure(readManifest(data, FROM)).message, /declares no plugin name/);
  }
});

test('anything that is not an object is not a manifest', () => {
  for (const data of [null, undefined, 'a string', 42, ['an', 'array']]) {
    assert.match(failure(readManifest(data, FROM)).message, /not a JSON object/);
  }
});

test('the probe order leads with the location Claude Code uses', () => {
  // The order is the contract: a plugin carrying two manifests is named by the
  // first, and Claude Code's is the one whose name it will be filed under.
  assert.equal(MANIFEST_FILES[0], '.claude-plugin/plugin.json');
  assert.deepEqual(
    [...MANIFEST_FILES],
    ['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'plugin.json'],
  );
});
