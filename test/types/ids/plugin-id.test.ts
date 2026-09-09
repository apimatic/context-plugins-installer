import test from 'node:test';
import assert from 'node:assert';

import { PluginId } from '../../../src/types/ids/plugin-id.js';

test('plugin ids must be kebab-case', () => {
  assert.equal(PluginId.create('acme-payments-sdk')?.toString(), 'acme-payments-sdk');
  assert.equal(PluginId.create('sdk1')?.toString(), 'sdk1');
  for (const bad of [
    '',
    'Has-Caps',
    'trailing-',
    '-leading',
    'has_underscore',
    'has space',
    '../etc',
    'a'.repeat(65),
  ]) {
    assert.equal(PluginId.create(bad), undefined, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

// The id arrives from a flag, an env var and the manifest, so anything at all
// can turn up here, not only a wrong-looking string.
test('anything that is not a string is refused too', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(PluginId.create(bad), undefined, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

test('parse says what was wrong and what was expected', () => {
  const parsed = PluginId.parse('Has-Caps');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.message, 'Invalid plugin id: "Has-Caps"');
  assert.equal(parsed.error.hint, 'Expected kebab-case, e.g. acme-payments');
});

test('two ids spelled the same are equal', () => {
  assert.equal(new PluginId('my-sdk').isEqual(new PluginId('my-sdk')), true);
  assert.equal(new PluginId('my-sdk').isEqual(new PluginId('other-sdk')), false);
});
