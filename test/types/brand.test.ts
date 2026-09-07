import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BIN } from '../../src/types/brand.js';
import { isPlainObject } from '../../src/util.js';

// Every hint that tells the user to run something interpolates BIN, so a drift
// from the installed command name would make all of them wrong.
test('BIN is the command name package.json actually installs', () => {
  const pkg: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  // Validated rather than cast: a missing `bin` should fail this assertion, not
  // throw a TypeError from inside Object.keys.
  if (!isPlainObject(pkg) || !isPlainObject(pkg.bin)) {
    assert.fail('package.json must declare a bin object');
  }
  assert.deepEqual(Object.keys(pkg.bin), [BIN]);
});
