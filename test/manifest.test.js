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
  manifest.upsert(f, entry({ repo: 'context-plugins/plugin-marketplace', marketplace: 'apimatic' }));
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  const plugins = manifest.list(f);
  assert.equal(plugins.length, 2, 'keyed by repo+plugin, not plugin alone');
  assert.deepEqual(
    plugins.map((p) => p.repo).sort(),
    ['acme/plugin-marketplace', 'context-plugins/plugin-marketplace'],
  );
});

test('find matches on repo+plugin, and on plugin alone when no repo is given', () => {
  const f = file();
  manifest.upsert(f, entry({ repo: 'acme/plugin-marketplace', marketplace: 'acme' }));
  assert.equal(manifest.find(f, { plugin: 'my-sdk', repo: 'acme/plugin-marketplace' }).marketplace, 'acme');
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
