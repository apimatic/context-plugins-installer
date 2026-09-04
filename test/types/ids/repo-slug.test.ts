import test from 'node:test';
import assert from 'node:assert';

import { RepoSlug } from '../../../src/types/ids/repo-slug.js';

const REPO = 'context-plugins/plugin-marketplace';

test('repos must be owner/repo', () => {
  assert.equal(RepoSlug.create(REPO)?.toString(), REPO);
  for (const bad of ['plugin-marketplace', 'a/b/c', 'a/b;rm -rf /', 'https://github.com/a/b', '']) {
    assert.equal(RepoSlug.create(bad), undefined, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

test('parse says what was wrong and what was expected', () => {
  const parsed = RepoSlug.parse('a/b/c');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.message, 'Invalid repo: "a/b/c"');
  assert.equal(parsed.error.hint, 'Expected owner/repo, e.g. acme/plugin-marketplace');
});

/**
 * These three strings are a wire contract: GitHub serves them, and the fetch
 * stubs in the suite key off the raw one. They are asserted in full rather than
 * by shape, because a silent change to any of them is a broken install.
 */
test('the URLs built from a slug are exactly what GitHub serves', () => {
  const slug = new RepoSlug(REPO);
  assert.equal(slug.cloneUrl(), `https://github.com/${REPO}.git`);
  assert.equal(
    slug.rawUrl('main', '.claude-plugin/marketplace.json'),
    `https://raw.githubusercontent.com/${REPO}/main/.claude-plugin/marketplace.json`,
  );
  assert.equal(
    slug.treeUrl('v1.2.0'),
    `https://api.github.com/repos/${REPO}/git/trees/v1.2.0?recursive=1`,
  );
});

// Claude's marketplace listing has carried the source under several spellings
// across CLI versions, and this is the one place that reads them.
test('a slug is recovered from however a listing spells it', () => {
  for (const text of [
    REPO,
    `https://github.com/${REPO}`,
    `https://github.com/${REPO}.git`,
    `git@github.com:${REPO}.git`,
    `  ${REPO}  `,
  ]) {
    assert.equal(RepoSlug.fromText(text)?.toString(), REPO, `did not read: ${text}`);
  }
});

test('text that names no repo yields nothing, rather than a wrong one', () => {
  for (const text of [null, undefined, '', 0, false, 'https://gitlab.com/a/b', 'not-a-repo']) {
    assert.equal(RepoSlug.fromText(text), undefined, `expected nothing from: ${String(text)}`);
  }
});

test('matching ignores case, the way GitHub does', () => {
  assert.equal(new RepoSlug(REPO).matches(new RepoSlug(REPO.toUpperCase())), true);
  assert.equal(new RepoSlug(REPO).matches(new RepoSlug('acme/other')), false);
});

test('the search key is lower-cased, for callers scanning text for a mention', () => {
  assert.equal(new RepoSlug('Acme/Payments').toSearchKey(), 'acme/payments');
});
