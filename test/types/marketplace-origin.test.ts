import test from 'node:test';
import assert from 'node:assert';

import { MarketplaceName } from '../../src/types/ids/marketplace-name.js';
import { RepoMarketplace, type MarketplaceOrigin } from '../../src/types/marketplace-origin.js';

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
  assert.equal(new RepoMarketplace('Acme/M', 'acme').key(), 'repo:acme/m::acme');
  assert.equal(new RepoMarketplace('acme/m').key(), 'repo:acme/m::');
});

test('a marketplace name differing only in case is not folded away', () => {
  // Claude Code keys a marketplace by the name it was added under, so the fold
  // is on the repo only.
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
  const named = RepoMarketplace.named('acme/m', new MarketplaceName('acme'));
  assert.equal(named.name, 'acme');
  assert.equal(named.key(), 'repo:acme/m::acme');
});

test('an empty name is not a known name, however it was constructed', () => {
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
