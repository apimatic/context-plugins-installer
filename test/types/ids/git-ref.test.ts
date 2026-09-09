import test from 'node:test';
import assert from 'node:assert';

import { GitRef } from '../../../src/types/ids/git-ref.js';

test('refs reject anything that could be read as a git option', () => {
  assert.equal(GitRef.create('main')?.toString(), 'main');
  assert.equal(GitRef.create('v1.2.0')?.toString(), 'v1.2.0');
  assert.equal(GitRef.create('release/2024-06')?.toString(), 'release/2024-06');
  for (const bad of ['--upload-pack=x', '-b', '', 'a ref']) {
    assert.equal(GitRef.create(bad), undefined, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

test('parse says what was wrong and what was expected', () => {
  const parsed = GitRef.parse('-b');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.message, 'Invalid ref: "-b"');
  assert.equal(parsed.error.hint, 'Expected a branch, tag, or commit sha, e.g. main');
});

// `git clone --branch` will not take a sha, so the clone path reads this to
// decide whether to fetch the commit separately.
test('commit shas are recognized so the clone path can switch strategy', () => {
  assert.equal(new GitRef('a1b2c3d').isSha(), true);
  assert.equal(new GitRef('0d5e6f70d5e6f70d5e6f70d5e6f70d5e6f70d5e6').isSha(), true);
  assert.equal(new GitRef('main').isSha(), false);
  assert.equal(new GitRef('v1.0.0').isSha(), false);
});

test('two refs spelled the same are equal', () => {
  assert.equal(new GitRef('main').isEqual(new GitRef('main')), true);
  assert.equal(new GitRef('main').isEqual(new GitRef('beta')), false);
});
