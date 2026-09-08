import test from 'node:test';
import assert from 'node:assert';

import { timestamp, stripBom } from '../src/util.js';
import { cleanupAll } from './helpers.js';

test.after(cleanupAll);

// What is left of this module is pure helpers. The identifier rules live with
// their types in test/types/ids, and the throwing wrapper that used to be here
// went with `UserError`: nothing in src throws for a problem the user can fix.
test('timestamp matches the PowerShell backup suffix format', () => {
  assert.equal(timestamp(new Date(2026, 6, 27, 9, 5, 3)), '20260727-090503');
});

test('stripBom only removes a leading BOM', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(stripBom(`${bom}{}`), '{}');
  assert.equal(stripBom('{}'), '{}');
});
