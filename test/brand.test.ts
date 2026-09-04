import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BIN, DEFAULTS, resolveBrand, type ResolveBrandOptions } from '../src/brand.js';
import { UserError } from '../src/util.js';
import { tmpDir, cleanupAll } from './helpers.js';

test.after(cleanupAll);

// Isolate every case from the developer's real cwd/home rc files.
const clean = (over: ResolveBrandOptions = {}): ResolveBrandOptions => ({
  env: {},
  cwd: tmpDir('cp-cwd-'),
  home: tmpDir('cp-home-'),
  ...over,
});

const writeRc = (dir: string, data: unknown): void =>
  fs.writeFileSync(path.join(dir, '.contextpluginsrc'), JSON.stringify(data), 'utf8');

test('with nothing configured, the built-in defaults apply', () => {
  const brand = resolveBrand(clean());
  assert.equal(brand.repo, 'context-plugins/plugin-marketplace');
  assert.equal(brand.ref, 'main');
  assert.equal(brand.id, null, 'marketplace name is read from the registry');
  assert.equal(brand.displayName, DEFAULTS.displayName);
});

// Every hint that tells the user to run something interpolates BIN, so a drift
// from the installed command name would make all of them wrong.
test('BIN is the command name package.json actually installs', () => {
  const pkg: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );
  const bin = (pkg as { bin: Record<string, string> }).bin;
  assert.deepEqual(Object.keys(bin), [BIN]);
});

test('the default marketplace name is not hardcoded', () => {
  const serialized = JSON.stringify(resolveBrand(clean())).toLowerCase();
  assert.ok(!serialized.includes('apimatic'), `unexpected default: ${serialized}`);
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
  // Object.assign throws on a frozen target, and the type system lets the attempt through.
  assert.throws(() => Object.assign(brand, { repo: 'x/y' }), TypeError);
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
  assert.equal(brand.repo, DEFAULTS.repo);
  assert.equal(brand.id, null);
});

test('an rc file that exists but cannot be read is reported, not skipped', () => {
  const cwd = tmpDir('cp-cwd-');
  fs.mkdirSync(path.join(cwd, '.contextpluginsrc')); // a directory, not a file
  assert.throws(() => resolveBrand(clean({ cwd })), /Could not read/);
});

test('an rc path that runs through a file is absence, not an unreadable rc', () => {
  const root = tmpDir('cp-home-');
  const notADir = path.join(root, 'a-file');
  fs.writeFileSync(notADir, 'x');
  // ENOTDIR on POSIX, ENOENT on Windows: either way no rc file can be there,
  // so the CLI carries on rather than aborting every command.
  const brand = resolveBrand(clean({ cwd: notADir, home: notADir }));
  assert.equal(brand.repo, DEFAULTS.repo);
});

test('telemetry defaults: the built-in token and US host, the built-in repo, no rc opt-out', () => {
  const brand = resolveBrand(clean());
  assert.equal(brand.telemetry.token, DEFAULTS.telemetryToken);
  assert.equal(brand.telemetry.host, 'https://api.mixpanel.com');
  assert.equal(brand.telemetry.defaultRepo, DEFAULTS.repo);
  assert.equal(brand.telemetry.rcOptOut, false);
});

test('a telemetry opt-out in the home rc survives a project rc that only names a repo', () => {
  const cwd = tmpDir('cp-cwd-');
  const home = tmpDir('cp-home-');
  writeRc(home, { telemetry: false });
  writeRc(cwd, { repo: 'acme/plugin-marketplace' });
  const brand = resolveBrand(clean({ cwd, home }));
  assert.equal(brand.repo, 'acme/plugin-marketplace', 'the project rc still sets the defaults');
  assert.equal(brand.telemetry.rcOptOut, true);
});

test('"telemetry": false in the rc file opts out; anything but a boolean is an error', () => {
  const cwd = tmpDir('cp-cwd-');
  writeRc(cwd, { telemetry: false });
  assert.equal(resolveBrand(clean({ cwd })).telemetry.rcOptOut, true);

  writeRc(cwd, { telemetry: 'no' });
  assert.throws(
    () => resolveBrand(clean({ cwd })),
    (err) => err instanceof UserError && /'telemetry' must be true or false/.test(err.message),
  );
});
