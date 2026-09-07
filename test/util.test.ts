import test from 'node:test';
import assert from 'node:assert';

import { UserError, assertPlugin, timestamp, stripBom } from '../src/util.js';
import { cleanupAll } from './helpers.js';

test.after(cleanupAll);

// The rules themselves live with the identifier types, in test/types/ids. What
// is left here is the wrapper: a rejected value becomes a UserError carrying the
// message and hint the type wrote, which is what the CLI prints. Only the plugin
// id still has one - brand resolution reads the repo and ref Results itself.
test('a valid plugin id passes straight through the assert wrapper', () => {
  assert.equal(assertPlugin('acme-payments-sdk'), 'acme-payments-sdk');
});

test('a rejected identifier throws a UserError carrying the hint its type wrote', () => {
  assert.throws(
    () => assertPlugin('Has-Caps'),
    (err) =>
      err instanceof UserError &&
      err.message === 'Invalid plugin id: "Has-Caps"' &&
      err.hint === 'Expected kebab-case, e.g. acme-payments',
  );
});

test('timestamp matches the PowerShell backup suffix format', () => {
  assert.equal(timestamp(new Date(2026, 6, 27, 9, 5, 3)), '20260727-090503');
});

test('stripBom only removes a leading BOM', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(stripBom(`${bom}{}`), '{}');
  assert.equal(stripBom('{}'), '{}');
});
