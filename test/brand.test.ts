import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBrand, type ResolveBrandOptions } from '../src/brand.js';
import { DEFAULTS } from '../src/types/brand.js';
import { UserError } from '../src/util.js';
import { tmpDir, cleanupAll } from './helpers.js';

test.after(cleanupAll);

// All that is left of this module is the seam: read both rc files, hand them to
// the pure resolver, throw what either of them reports. The precedence chain is
// test/application/brand-resolution.test.ts and the file rules are
// test/infrastructure/rc-file.test.ts; this is the wiring between them, which
// is the one thing neither of those can see.

// Isolate every case from the developer's real cwd/home rc files.
const clean = (over: ResolveBrandOptions = {}): ResolveBrandOptions => ({
  env: {},
  cwd: tmpDir('cp-cwd-'),
  home: tmpDir('cp-home-'),
  ...over,
});

const writeRc = (dir: string, data: unknown): void =>
  fs.writeFileSync(path.join(dir, '.contextpluginsrc'), JSON.stringify(data), 'utf8');

test('both files are read from disk, and the nearer one wins the field it sets', () => {
  const cwd = tmpDir('cp-cwd-');
  const home = tmpDir('cp-home-');
  writeRc(home, { repo: 'home/marketplace', ref: 'stable' });
  writeRc(cwd, { repo: 'cwd/marketplace' });
  const brand = resolveBrand(clean({ cwd, home }));
  assert.equal(brand.repo, 'cwd/marketplace');
  assert.equal(brand.ref, 'stable', 'and the home file still supplies the rest');
});

test('with no files anywhere, the built-in defaults apply', () => {
  assert.equal(resolveBrand(clean()).repo, DEFAULTS.repo);
});

test('an unusable rc file reports the file, and does so as a UserError', () => {
  const cwd = tmpDir('cp-cwd-');
  fs.writeFileSync(path.join(cwd, '.contextpluginsrc'), '{ broken', 'utf8');
  assert.throws(
    () => resolveBrand(clean({ cwd })),
    (err) => err instanceof UserError && /is not valid JSON/.test(err.message),
  );
});

test('a value the resolver rejects arrives as a UserError too', () => {
  assert.throws(
    () => resolveBrand(clean({ env: { CP_REPO: 'not-a-repo' } })),
    (err) => err instanceof UserError && /Invalid repo/.test(err.message),
  );
});
