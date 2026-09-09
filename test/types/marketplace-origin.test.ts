import test from 'node:test';
import assert from 'node:assert';

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

test('the key is the format the session already memoised under', () => {
  // Pinned rather than derived: a change here re-registers a marketplace every
  // build has already added, so it has to be a deliberate one.
  assert.equal(new RepoMarketplace('Acme/M', 'acme').key(), 'acme/m::acme');
  assert.equal(new RepoMarketplace('acme/m').key(), 'acme/m::');
});

test('two marketplace names in one repository are two keys', () => {
  const one = new RepoMarketplace('acme/m', 'acme');
  const two = new RepoMarketplace('acme/m', 'acme-internal');
  assert.notEqual(one.key(), two.key());
});

test('a named origin carries a name the reader does not have to allow for', () => {
  const named = RepoMarketplace.named('acme/m', 'acme');
  // The interesting half is the type: `named.name` is a `string` here, which is
  // what lets `ResolvedPlugin` and the registration path stop checking for null.
  assert.equal(named.name, 'acme');
  assert.equal(named.key(), 'acme/m::acme');
});

test('hasName narrows, so a caller that asked need not carry the answer', () => {
  const named: MarketplaceOrigin = new RepoMarketplace('acme/m', 'acme');
  const nameless: MarketplaceOrigin = new RepoMarketplace('acme/m');
  assert.equal(named.hasName(), true);
  assert.equal(nameless.hasName(), false);
  if (named.hasName()) assert.equal(named.name.length, 4);
});

test('a message names the repository it came from', () => {
  assert.equal(new RepoMarketplace('acme/m', 'acme').describe(), 'acme/m');
});

test('the discriminant is readable through the union, for the arms to come', () => {
  const origin: MarketplaceOrigin = new RepoMarketplace('acme/m', 'acme');
  assert.equal(origin.kind, 'repo');
});
