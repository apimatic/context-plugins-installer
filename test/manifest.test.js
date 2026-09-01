'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const manifest = require('../src/manifest');
const { tmpDir, cleanupAll } = require('./helpers');

test.after(cleanupAll);

const file = () => path.join(tmpDir('cp-manifest-'), 'installed.json');

const entry = (over = {}) => ({
  plugin: 'my-sdk',
  repo: 'context-plugins/plugin-marketplace',
  marketplace: 'apimatic',
  ref: 'main',
  targets: ['claude'],
  ...over,
});

test('a missing manifest reads as empty', () => {
  assert.deepEqual(manifest.read(file()).plugins, []);
});

test('a corrupt manifest reads as empty instead of throwing', () => {
  const f = file();
  fs.writeFileSync(f, 'not json at all');
  assert.deepEqual(manifest.read(f).plugins, []);
});

test('upsert adds an entry and stamps the version', () => {
  const f = file();
  manifest.upsert(f, entry());
  const data = manifest.read(f);
  assert.equal(data.version, manifest.MANIFEST_VERSION);
  assert.equal(data.plugins.length, 1);
  assert.equal(data.plugins[0].plugin, 'my-sdk');
});

test('upsert replaces the same repo+plugin rather than duplicating', () => {
  const f = file();
  manifest.upsert(f, entry({ targets: ['claude'] }));
  manifest.upsert(f, entry({ targets: ['claude', 'cursor', 'vscode'] }));
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0].targets, ['claude', 'cursor', 'vscode']);
});

test('the same plugin id from two marketplaces coexists', () => {
  const f = file();
  manifest.upsert(
    f,
    entry({ repo: 'context-plugins/plugin-marketplace', marketplace: 'apimatic' }),
  );
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 2, 'keyed by repo+plugin, not plugin alone');
  assert.deepEqual(plugins.map((p) => p.repo).sort(), [
    'acme/plugin-marketplace',
    'context-plugins/plugin-marketplace',
  ]);
});

test('find matches on repo+plugin, and on plugin alone when no repo is given', () => {
  const f = file();
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  assert.equal(
    manifest.find(f, { plugin: 'my-sdk', repo: 'acme/plugin-marketplace' }).marketplace,
    'acme',
  );
  assert.equal(manifest.find(f, { plugin: 'my-sdk', repo: 'other/repo' }), null);
  assert.equal(manifest.find(f, { plugin: 'my-sdk' }).marketplace, 'acme');
});

test('remove deletes only the matching repo+plugin', () => {
  const f = file();
  manifest.upsert(f, entry({ repo: 'context-plugins/plugin-marketplace' }));
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace' }));
  const removed = manifest.remove(f, { plugin: 'my-sdk', repo: 'acme/plugin-marketplace' });
  assert.equal(removed, 1);
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].repo, 'context-plugins/plugin-marketplace');
});

test('a manifest written by the PowerShell installer is readable', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      plugins: [
        {
          plugin: 'legacy-sdk',
          repo: 'context-plugins/plugin-marketplace',
          marketplace: 'apimatic',
          ref: 'main',
          targets: ['claude', 'cursor'],
        },
      ],
    }),
  );
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].plugin, 'legacy-sdk');
});

test('an unknown target is filtered out on read, keeping the rest', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ plugins: [entry({ targets: ['claude', 'zed'] })] }));
  assert.deepEqual(manifest.list(f)[0].targets, ['claude']);
});

test('an entry with no usable target is dropped, never read as "all"', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      plugins: [
        entry({ targets: ['zed'] }), // every target unknown
        entry({ targets: [] }), // recorded with none
        entry({ targets: 'claude' }), // not even an array
      ],
    }),
  );
  assert.deepEqual(manifest.list(f), []);
});

test('junk entries do not survive read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({
      plugins: [null, 42, 'my-sdk', { targets: ['claude'] }, { plugin: 7, targets: ['claude'] }],
    }),
  );
  assert.deepEqual(manifest.list(f), []);
});

test('non-string metadata fields are shed instead of passed along', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ plugins: [entry({ ref: 42, marketplace: ['x'] })] }));
  const read = manifest.list(f)[0];
  assert.equal(read.ref, undefined);
  assert.equal(read.marketplace, undefined);
  assert.equal(read.repo, 'context-plugins/plugin-marketplace', 'valid fields survive');
});

test('targets are deduped into canonical order on read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ targets: ['vscode', 'claude', 'claude'] })] }),
  );
  assert.deepEqual(manifest.list(f)[0].targets, ['claude', 'vscode']);
});

test('read names what it ignored instead of hiding it', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry(), entry({ plugin: 'future-sdk', targets: ['zed'] }), null] }),
  );
  const { plugins, ignored } = manifest.read(f);
  assert.equal(plugins.length, 1);
  assert.deepEqual(ignored, [
    { plugin: 'future-sdk', reason: 'unknown target(s): zed' },
    { plugin: null, reason: 'not a plugin entry' },
  ]);
});

test('an unrelated upsert never deletes entries this build cannot read', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ plugin: 'future-sdk', targets: ['zed'] }), null] }),
  );
  manifest.upsert(f, entry());
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8')).plugins;
  assert.equal(onDisk.length, 3, 'the unreadable entries are still on disk');
  assert.ok(onDisk.some((p) => p && p.plugin === 'future-sdk' && p.targets.includes('zed')));
  assert.ok(onDisk.includes(null));
});

test('remove leaves entries it cannot read alone', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry(), entry({ plugin: 'future-sdk', targets: ['zed'] })] }),
  );
  manifest.remove(f, { plugin: 'my-sdk', repo: 'context-plugins/plugin-marketplace' });
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8')).plugins;
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].plugin, 'future-sdk');
});

test('findRaw returns the rows read hides', () => {
  const f = file();
  fs.writeFileSync(
    f,
    JSON.stringify({ plugins: [entry({ plugin: 'future-sdk', targets: ['zed'] })] }),
  );
  const key = { plugin: 'future-sdk', repo: 'context-plugins/plugin-marketplace' };
  assert.equal(manifest.find(f, key), null, 'the sanitized view hides it');
  assert.deepEqual(manifest.findRaw(f, key).targets, ['zed']);
});
