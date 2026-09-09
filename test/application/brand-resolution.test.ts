import test from 'node:test';
import assert from 'node:assert';

import { resolveBrand, type BrandSources } from '../../src/application/brand-resolution.js';
import { DEFAULTS, type Brand, type RcFile } from '../../src/types/brand.js';
import type { Failure } from '../../src/types/failure.js';

// The precedence chain, over rc files already read: flag -> CP_* env -> cwd rc
// -> home rc -> defaults. Reading the files is
// test/infrastructure/rc-file.test.ts; nothing here touches a disk.

const brandOf = (over: Partial<BrandSources> = {}): Brand => {
  const result = resolveBrand({ env: {}, ...over });
  assert.ok(result.ok, `expected a brand, got: ${result.ok ? '' : result.error.message}`);
  return result.value;
};

const failure = (over: Partial<BrandSources>): Failure => {
  const result = resolveBrand({ env: {}, ...over });
  assert.ok(!result.ok, 'expected a failure');
  return result.error;
};

const rc = (data: RcFile): RcFile => data;

test('with nothing configured, the built-in defaults apply', () => {
  const brand = brandOf();
  assert.equal(brand.repo, 'context-plugins/plugin-marketplace');
  assert.equal(brand.ref, 'main');
  assert.equal(brand.id, null, 'marketplace name is read from the registry');
  assert.equal(brand.displayName, DEFAULTS.displayName);
});

test('the default marketplace name is not hardcoded', () => {
  const serialized = JSON.stringify(brandOf()).toLowerCase();
  assert.ok(!serialized.includes('apimatic'), `unexpected default: ${serialized}`);
});

test('cwd rc beats home rc', () => {
  const brand = brandOf({
    cwdRc: rc({ repo: 'cwd/marketplace' }),
    homeRc: rc({ repo: 'home/marketplace' }),
  });
  assert.equal(brand.repo, 'cwd/marketplace');
});

test('home rc applies when cwd has none', () => {
  const brand = brandOf({ homeRc: rc({ repo: 'home/marketplace', marketplace: 'homebrand' }) });
  assert.equal(brand.repo, 'home/marketplace');
  assert.equal(brand.id, 'homebrand');
});

test('env beats the rc file', () => {
  const brand = brandOf({
    cwdRc: rc({ repo: 'rc/marketplace' }),
    env: { CP_REPO: 'env/marketplace' },
  });
  assert.equal(brand.repo, 'env/marketplace');
});

test('a CLI flag beats everything', () => {
  const brand = brandOf({
    cwdRc: rc({ repo: 'rc/marketplace' }),
    env: { CP_REPO: 'env/marketplace', CP_REF: 'envref' },
    flags: { repo: 'flag/marketplace', ref: 'flagref', marketplace: 'flagmkt' },
  });
  assert.equal(brand.repo, 'flag/marketplace');
  assert.equal(brand.ref, 'flagref');
  assert.equal(brand.id, 'flagmkt');
});

test('CP_MARKETPLACE and CP_REF are honoured', () => {
  const brand = brandOf({ env: { CP_MARKETPLACE: 'acme', CP_REF: 'v2.0.0' } });
  assert.equal(brand.id, 'acme');
  assert.equal(brand.ref, 'v2.0.0');
});

test('a malformed repo is rejected at resolution time', () => {
  assert.match(failure({ env: { CP_REPO: 'not-a-repo' } }).message, /Invalid repo/);
  assert.match(failure({ env: { CP_REPO: 'a/b/c;rm -rf' } }).message, /Invalid repo/);
});

test('a malformed ref is rejected at resolution time', () => {
  assert.match(failure({ env: { CP_REF: '--upload-pack=evil' } }).message, /Invalid ref/);
});

test('an empty value is unset, not a value that beats the file below it', () => {
  const brand = brandOf({ cwdRc: rc({ repo: 'rc/marketplace' }), env: { CP_REPO: '' } });
  assert.equal(brand.repo, 'rc/marketplace');
});

test('the resolved brand is frozen', () => {
  const brand = brandOf();
  // Object.assign throws on a frozen target, and the type system lets the attempt through.
  assert.throws(() => Object.assign(brand, { repo: 'x/y' }), TypeError);
  assert.throws(() => Object.assign(brand.telemetry, { token: 'x' }), TypeError);
});

test('telemetry defaults: the built-in token and US host, the built-in repo, no rc opt-out', () => {
  const brand = brandOf();
  assert.equal(brand.telemetry.token, DEFAULTS.telemetryToken);
  assert.equal(brand.telemetry.host, 'https://api.mixpanel.com');
  assert.equal(brand.telemetry.defaultRepo, DEFAULTS.repo);
  assert.equal(brand.telemetry.rcOptOut, false);
});

test('"telemetry": false in either rc file opts out', () => {
  assert.equal(brandOf({ cwdRc: rc({ telemetry: false }) }).telemetry.rcOptOut, true);
  assert.equal(brandOf({ homeRc: rc({ telemetry: false }) }).telemetry.rcOptOut, true);
});

/**
 * The two rc files merge field by field. Taking the first found whole meant a
 * project rc that set only `telemetry` discarded the home rc's marketplace, so
 * opting out of telemetry in one repository silently moved every install in it
 * to the built-in marketplace.
 */
test('a project rc that sets only telemetry keeps the home marketplace', () => {
  const brand = brandOf({
    homeRc: rc({ repo: 'acme/private-marketplace', displayName: 'Acme' }),
    cwdRc: rc({ telemetry: false }),
  });
  assert.equal(brand.repo, 'acme/private-marketplace', 'the home rc still names the marketplace');
  assert.equal(brand.displayName, 'Acme');
  assert.equal(brand.telemetry.rcOptOut, true, 'and the project opt-out is honoured');
});

test('a field set in both files is the project rc to decide', () => {
  const brand = brandOf({
    homeRc: rc({ repo: 'home/marketplace', ref: 'stable' }),
    cwdRc: rc({ repo: 'cwd/marketplace' }),
  });
  assert.equal(brand.repo, 'cwd/marketplace', 'the nearer file wins the field it sets');
  assert.equal(brand.ref, 'stable', 'and leaves the ones it does not');
});

test('the label follows the display name unless one is given', () => {
  assert.equal(brandOf({ env: { CP_DISPLAY_NAME: 'Acme' } }).label, 'Acme Marketplace');
  assert.equal(
    brandOf({ env: { CP_DISPLAY_NAME: 'Acme', CP_MARKETPLACE_LABEL: 'The Acme Shelf' } }).label,
    'The Acme Shelf',
  );
});
