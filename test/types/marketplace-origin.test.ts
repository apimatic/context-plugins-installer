import test from 'node:test';
import assert from 'node:assert';

import { MarketplaceName } from '../../src/types/ids/marketplace-name.js';
import { RepoMarketplace, type MarketplaceOrigin } from '../../src/types/marketplace-origin.js';

// The name and the repository as one value. What is worth asserting here is the
// memo key - it is the only behaviour the type carries, and the session and the
// Claude harness both depend on two spellings of one repository producing it.

test('the name is optional, because an offline uninstall has none to give', () => {
  assert.equal(new RepoMarketplace('acme/plugin-marketplace').name, null);
  assert.equal(new RepoMarketplace('acme/plugin-marketplace', 'acme').name, 'acme');
});

test('the key folds the repo the way GitHub reads it, so two spellings memoise once', () => {
  const upper = new RepoMarketplace('Acme/M', 'acme');
  const lower = new RepoMarketplace('acme/m', 'acme');
  assert.equal(upper.key(), lower.key());
});

test('the key leads with the discriminant, so a second kind cannot fold into it', () => {
  // Pinned rather than derived. The memo is a per-run in-memory Map, so the
  // format costs nothing to change - what it must not do is let two origins of
  // different kinds agree, since `session.marketplaces` is keyed on this string
  // alone and would hand one of them the other's cached registration.
  assert.equal(new RepoMarketplace('Acme/M', 'acme').key(), 'repo:acme/m::acme');
  assert.equal(new RepoMarketplace('acme/m').key(), 'repo:acme/m::');
});

test('a marketplace name differing only in case is not folded away', () => {
  // Claude Code keys a marketplace by the name it was added under, and nothing
  // here has evidence it reads two spellings of one name as one marketplace -
  // so the fold is on the repo only, and that is the deliberate half.
  const upper = new RepoMarketplace('acme/m', 'Acme');
  const lower = new RepoMarketplace('acme/m', 'acme');
  assert.notEqual(upper.key(), lower.key());
});

test('two marketplace names in one repository are two keys', () => {
  const one = new RepoMarketplace('acme/m', 'acme');
  const two = new RepoMarketplace('acme/m', 'acme-internal');
  assert.notEqual(one.key(), two.key());
});

test('a named origin carries a name the reader does not have to allow for', () => {
  // It takes a validated `MarketplaceName`, which is what makes the return type
  // honest: an empty name cannot be one, so it cannot reach here.
  const named = RepoMarketplace.named('acme/m', new MarketplaceName('acme'));
  assert.equal(named.name, 'acme');
  assert.equal(named.key(), 'repo:acme/m::acme');
});

test('an empty name is not a known name, however it was constructed', () => {
  // The hole this closes: `!== null` let `''` through, the install guard cleared,
  // and the harness spelled `plugin install <id>@` with nothing after the `@`.
  // `nonEmptyString` is the rule, so whitespace still counts as a name - the
  // point is agreeing with the harness's own reading, not being stricter than it.
  assert.equal(new RepoMarketplace('acme/m', '').hasName(), false);
  assert.equal(new RepoMarketplace('acme/m', 'acme').hasName(), true);
});

test('hasName narrows, so a caller that asked need not carry the answer', () => {
  const named: MarketplaceOrigin = new RepoMarketplace('acme/m', 'acme');
  const nameless: MarketplaceOrigin = new RepoMarketplace('acme/m');
  assert.equal(named.hasName(), true);
  assert.equal(nameless.hasName(), false);
  if (named.hasName()) assert.equal(named.name.length, 4);
});

test('a message names the repository it came from', () => {
  assert.equal(`${new RepoMarketplace('acme/m', 'acme')}`, 'acme/m');
});

test('the discriminant is readable through the union, for the arms to come', () => {
  const origin: MarketplaceOrigin = new RepoMarketplace('acme/m', 'acme');
  assert.equal(origin.kind, 'repo');
});
