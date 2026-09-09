import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RC_NAME, readRc } from '../../src/infrastructure/rc-file.js';
import type { RcFile } from '../../src/types/brand.js';
import { tmpDir, cleanupAll } from '../helpers.js';

test.after(cleanupAll);

// `.contextpluginsrc` is user-written configuration, not shared state, so
// anything wrong with it is a Failure naming the file: falling back to the
// defaults silently would install from the wrong marketplace. Absence is the
// ordinary case and reads as `null`.

const withRc = (data: unknown): string => {
  const dir = tmpDir('cp-rc-');
  fs.writeFileSync(path.join(dir, RC_NAME), JSON.stringify(data), 'utf8');
  return dir;
};

const withRaw = (text: string): string => {
  const dir = tmpDir('cp-rc-');
  fs.writeFileSync(path.join(dir, RC_NAME), text, 'utf8');
  return dir;
};

const value = (dir: string | undefined): RcFile | null => {
  const result = readRc(dir);
  assert.ok(result.ok, `expected a read, got: ${result.ok ? '' : result.error.message}`);
  return result.value;
};

const message = (dir: string): string => {
  const result = readRc(dir);
  assert.ok(!result.ok, 'expected a failure');
  return result.error.message;
};

test('no rc file at all is absence, not a failure', () => {
  assert.equal(value(tmpDir('cp-rc-')), null);
  assert.equal(value(undefined), null, 'and neither is having nowhere to look');
});

test('a file that is there is read into the fields this build knows', () => {
  assert.deepEqual(value(withRc({ repo: 'acme/m', ref: 'v2', telemetry: false })), {
    repo: 'acme/m',
    ref: 'v2',
    telemetry: false,
  });
});

test('invalid JSON reports the file, not a stack trace', () => {
  assert.match(message(withRaw('{ broken')), /is not valid JSON/);
});

test('an rc file that is not an object reports the file', () => {
  assert.match(message(withRaw('[1, 2]')), /must be a JSON object/);
});

test('an rc field of the wrong type names the field, not a downstream symptom', () => {
  assert.match(message(withRc({ repo: 123 })), /'repo' must be a string/);
});

test('"telemetry" must be a boolean, and says so', () => {
  assert.match(message(withRc({ telemetry: 'no' })), /'telemetry' must be true or false/);
});

test('unknown rc fields are ignored for forward compatibility', () => {
  assert.deepEqual(value(withRc({ repo: 'rc/marketplace', futureOption: { nested: true } })), {
    repo: 'rc/marketplace',
  });
});

test('a null rc field means unset, exactly like the resolution chain treats it', () => {
  assert.deepEqual(value(withRc({ repo: null, marketplace: null, telemetry: null })), {});
});

test('an rc file that exists but cannot be read is reported, not skipped', () => {
  const dir = tmpDir('cp-rc-');
  fs.mkdirSync(path.join(dir, RC_NAME)); // a directory, not a file
  assert.match(message(dir), /Could not read/);
});

// ENOTDIR on POSIX, ENOENT on Windows: either way no rc file can be there, so
// the CLI carries on rather than aborting every command.
test('an rc path that runs through a file is absence, not an unreadable rc', () => {
  const notADir = path.join(tmpDir('cp-rc-'), 'a-file');
  fs.writeFileSync(notADir, 'x');
  assert.equal(value(notADir), null);
});
