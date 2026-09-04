import test from 'node:test';
import assert from 'node:assert';

import {
  UserError,
  assertPlugin,
  assertRepo,
  assertRef,
  pool,
  timestamp,
  stripBom,
  suggest,
} from '../src/util.js';
import { cleanupAll } from './helpers.js';

test.after(cleanupAll);

// The rules themselves live with the identifier types, in test/types/ids. What
// is left here is the wrapper: a rejected value becomes a UserError carrying the
// message and hint the type wrote, which is what the CLI prints.
test('a valid identifier passes straight through the assert wrappers', () => {
  assert.equal(assertPlugin('acme-payments-sdk'), 'acme-payments-sdk');
  assert.equal(
    assertRepo('context-plugins/plugin-marketplace'),
    'context-plugins/plugin-marketplace',
  );
  assert.equal(assertRef('release/2024-06'), 'release/2024-06');
});

test('a rejected identifier throws a UserError carrying the hint its type wrote', () => {
  assert.throws(
    () => assertPlugin('Has-Caps'),
    (err) =>
      err instanceof UserError &&
      err.message === 'Invalid plugin id: "Has-Caps"' &&
      err.hint === 'Expected kebab-case, e.g. acme-payments',
  );
  assert.throws(
    () => assertRepo('a/b/c'),
    (err) =>
      err instanceof UserError && err.hint === 'Expected owner/repo, e.g. acme/plugin-marketplace',
  );
  assert.throws(
    () => assertRef('--upload-pack=x'),
    (err) =>
      err instanceof UserError && err.hint === 'Expected a branch, tag, or commit sha, e.g. main',
  );
});

test('pool preserves input order regardless of completion order', async () => {
  const items = [30, 5, 20, 1, 10];
  const results = await pool(items, 2, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(results, items);
});

test('timestamp matches the PowerShell backup suffix format', () => {
  assert.equal(timestamp(new Date(2026, 6, 27, 9, 5, 3)), '20260727-090503');
});

test('suggest finds a near miss even when a shared suffix inflates the distance', () => {
  const names = ['azure-cognitive-sdk', 'docker-sdk', 'vimeo-sdk'];
  assert.deepEqual(suggest('azure-cognitve', names), ['azure-cognitive-sdk']);
  assert.deepEqual(suggest('docker', names), ['docker-sdk']);
  assert.deepEqual(suggest('zzzzzzzzzzzzzzzz', names), []);
});

test('stripBom only removes a leading BOM', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(stripBom(`${bom}{}`), '{}');
  assert.equal(stripBom('{}'), '{}');
});
