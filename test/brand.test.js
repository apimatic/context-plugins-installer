'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveBrand, DEFAULT_PROFILE } = require('../src/brand');
const { UserError } = require('../src/util');
const { tmpDir, cleanupAll } = require('./helpers');

test.after(cleanupAll);

// Isolate every case from the developer's real cwd/home rc files.
const clean = (over = {}) => ({
  env: {},
  cwd: tmpDir('cp-cwd-'),
  home: tmpDir('cp-home-'),
  ...over,
});

const writeRc = (dir, data) =>
  fs.writeFileSync(path.join(dir, '.contextpluginsrc'), JSON.stringify(data), 'utf8');

test('with nothing configured, the built-in defaults apply', () => {
  const brand = resolveBrand(clean());
  assert.equal(brand.repo, 'context-plugins/plugin-marketplace');
  assert.equal(brand.ref, 'main');
  assert.equal(brand.bin, 'context-plugins');
  assert.equal(brand.id, null, 'marketplace name is read from the registry');
  assert.equal(brand.displayName, DEFAULT_PROFILE.displayName);
});

test('the default marketplace name is not hardcoded', () => {
  const serialized = JSON.stringify(resolveBrand(clean())).toLowerCase();
  assert.ok(!serialized.includes('apimatic'), `unexpected default: ${serialized}`);
});

test('a preset profile overrides the defaults', () => {
  const brand = resolveBrand({
    ...clean(),
    profile: {
      id: 'acme',
      repo: 'acme/plugin-marketplace',
      displayName: 'Acme AI',
      bin: 'acme-plugins',
    },
  });
  assert.equal(brand.repo, 'acme/plugin-marketplace');
  assert.equal(brand.id, 'acme');
  assert.equal(brand.bin, 'acme-plugins');
  assert.equal(brand.displayName, 'Acme AI');
});

test('an rc file in cwd beats the preset profile', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { repo: 'rc/marketplace' });
  const brand = resolveBrand({ ...clean({ cwd }), profile: { repo: 'acme/plugin-marketplace' } });
  assert.equal(brand.repo, 'rc/marketplace');
});

test('cwd rc beats home rc', () => {
  const cwd = tmpDir('cp-cwd-');
  const home = tmpDir('cp-home-');
  writeRc(cwd, { repo: 'cwd/marketplace' });
  writeRc(home, { repo: 'home/marketplace' });
  assert.equal(resolveBrand(clean({ cwd, home })).repo, 'cwd/marketplace');
});

test('home rc applies when cwd has none', () => {
  const home = tmpDir('cp-home-');
  writeRc(home, { repo: 'home/marketplace', marketplace: 'homebrand' });
  const brand = resolveBrand(clean({ home }));
  assert.equal(brand.repo, 'home/marketplace');
  assert.equal(brand.id, 'homebrand');
});

test('env beats the rc file', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { repo: 'rc/marketplace' });
  const brand = resolveBrand(clean({ cwd, env: { CP_REPO: 'env/marketplace' } }));
  assert.equal(brand.repo, 'env/marketplace');
});

test('a CLI flag beats everything', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { repo: 'rc/marketplace' });
  const brand = resolveBrand({
    ...clean({ cwd, env: { CP_REPO: 'env/marketplace', CP_REF: 'envref' } }),
    profile: { repo: 'acme/plugin-marketplace' },
    flags: { repo: 'flag/marketplace', ref: 'flagref', marketplace: 'flagmkt' },
  });
  assert.equal(brand.repo, 'flag/marketplace');
  assert.equal(brand.ref, 'flagref');
  assert.equal(brand.id, 'flagmkt');
});

test('CP_MARKETPLACE and CP_REF are honoured', () => {
  const brand = resolveBrand(clean({ env: { CP_MARKETPLACE: 'acme', CP_REF: 'v2.0.0' } }));
  assert.equal(brand.id, 'acme');
  assert.equal(brand.ref, 'v2.0.0');
});

test('a malformed repo is rejected at resolution time', () => {
  assert.throws(() => resolveBrand(clean({ env: { CP_REPO: 'not-a-repo' } })), UserError);
  assert.throws(() => resolveBrand(clean({ env: { CP_REPO: 'a/b/c;rm -rf' } })), UserError);
});

test('a malformed ref is rejected at resolution time', () => {
  assert.throws(() => resolveBrand(clean({ env: { CP_REF: '--upload-pack=evil' } })), UserError);
});

test('an invalid rc file reports the file, not a stack trace', () => {
  const cwd = tmpDir('cp-cwd-');
  fs.writeFileSync(path.join(cwd, '.contextpluginsrc'), '{ broken', 'utf8');
  assert.throws(() => resolveBrand(clean({ cwd })), UserError);
});

test('the resolved brand is frozen', () => {
  const brand = resolveBrand(clean());
  assert.throws(() => {
    'use strict';
    brand.repo = 'x/y';
  }, TypeError);
});

test('an rc file that is not an object reports the file', () => {
  const cwd = tmpDir('cp-cwd-');
  fs.writeFileSync(path.join(cwd, '.contextpluginsrc'), '[1, 2]', 'utf8');
  assert.throws(() => resolveBrand(clean({ cwd })), /must be a JSON object/);
});

test('an rc field of the wrong type names the field, not a downstream symptom', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { repo: 123 });
  assert.throws(() => resolveBrand(clean({ cwd })), /'repo' must be a string/);
});

test('unknown rc fields are ignored for forward compatibility', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { repo: 'rc/marketplace', futureOption: { nested: true } });
  assert.equal(resolveBrand(clean({ cwd })).repo, 'rc/marketplace');
});

test('a null rc field means unset, exactly like the resolution chain treats it', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { repo: null, marketplace: null });
  const brand = resolveBrand(clean({ cwd }));
  assert.equal(brand.repo, DEFAULT_PROFILE.repo);
  assert.equal(brand.id, null);
});

test('an rc file that exists but cannot be read is reported, not skipped', () => {
  const cwd = tmpDir('cp-cwd-');
  fs.mkdirSync(path.join(cwd, '.contextpluginsrc')); // a directory, not a file
  assert.throws(() => resolveBrand(clean({ cwd })), /Could not read/);
});
