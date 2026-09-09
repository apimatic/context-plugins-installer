import test from 'node:test';
import assert from 'node:assert';

import { MarketplaceName } from '../../../src/types/ids/marketplace-name.js';

test('a marketplace name is a kebab-case identifier', () => {
  for (const good of ['context-plugins', 'acme', 'my_marketplace', 'a.b', 'sdk1', 'Acme-Plugins']) {
    assert.equal(MarketplaceName.create(good)?.toString(), good, `expected accepted: ${good}`);
  }
});

test('anything with a space, or a dangling separator, is refused', () => {
  for (const bad of ['has space', '', 'trailing-', '-leading', 'two--dashes', null, 42, {}]) {
    assert.equal(
      MarketplaceName.create(bad),
      undefined,
      `expected rejection: ${JSON.stringify(bad)}`,
    );
  }
});

// Both callers word their own message around this phrase, because what to do
// about a bad name depends on where the name came from. It is asserted here so
// neither message can drift from the rule it describes.
test('the rule is stated once, in the words both messages use', () => {
  assert.equal(MarketplaceName.RULE, 'kebab-case with no spaces');
});
