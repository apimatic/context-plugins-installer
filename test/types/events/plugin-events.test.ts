import test from 'node:test';
import assert from 'node:assert';

import { MarketplaceLabel } from '../../../src/types/brand.js';
import { PluginInstallFailedEvent } from '../../../src/types/events/plugin-install-failed.js';
import { PluginInstalledEvent } from '../../../src/types/events/plugin-installed.js';
import { PluginUninstallFailedEvent } from '../../../src/types/events/plugin-uninstall-failed.js';
import { PluginUninstalledEvent } from '../../../src/types/events/plugin-uninstalled.js';
import { PluginId } from '../../../src/types/ids/plugin-id.js';
import { DEFAULTS, type BrandTelemetry } from '../../../src/types/brand.js';

// The four things this program reports, as the Mixpanel project receives them.
// Property names are a schema: renaming one silently splits a funnel that has
// history behind it, so each is pinned here rather than left to a call site.

const BUILT_IN = DEFAULTS.repo;

const telemetry: BrandTelemetry = {
  defaultRepo: BUILT_IN,
  token: DEFAULTS.telemetryToken,
  host: DEFAULTS.telemetryHost,
  rcOptOut: false,
};
const builtIn = MarketplaceLabel.of({ repo: BUILT_IN, telemetry });
const custom = MarketplaceLabel.of({ repo: 'acme/plugin-marketplace', telemetry });
const plugin = new PluginId('my-sdk');

test('an install reports the editor, the marketplace and how long it took', () => {
  const event = new PluginInstalledEvent(plugin, 'cursor', builtIn, 'marketplace', true, 1234);
  assert.equal(event.name, 'Context Plugin Installed');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    harness: 'cursor',
    marketplace: BUILT_IN,
    source_kind: 'marketplace',
    targets_explicit: true,
    duration_ms: 1234,
  });
});

/**
 * A plugin installed from a directory is named by a folder the user chose,
 * which makes it their name rather than a public one. `PluginSource` is what
 * decides that - these events only have to be able to carry the answer.
 */
test('a local install reports its kind and withholds the plugin name', () => {
  const event = new PluginInstalledEvent(null, 'cursor', custom, 'local', true, 5);
  assert.equal(event.properties().plugin, null);
  assert.equal(event.properties().source_kind, 'local');
  assert.equal(event.properties().marketplace, 'custom');
});

test('a failed install reports the stage and the kind, and nothing else', () => {
  const event = new PluginInstallFailedEvent(plugin, custom, 'marketplace', 'fetch', 'user');
  assert.equal(event.name, 'Context Plugin Install Failed');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    marketplace: 'custom',
    source_kind: 'marketplace',
    stage: 'fetch',
    error_kind: 'user',
  });
});

test('a failure before the argument parsed reports no source kind either', () => {
  // Neither an id nor a path: there is no source, so there is nothing true to
  // say about where it would have come from.
  const event = new PluginInstallFailedEvent(null, builtIn, null, 'resolve', 'user');
  assert.equal(event.properties().source_kind, null);
});

test('an uninstall reports one editor and the marketplace', () => {
  const event = new PluginUninstalledEvent(plugin, 'vscode', builtIn, 'marketplace');
  assert.equal(event.name, 'Context Plugin Uninstalled');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    harness: 'vscode',
    marketplace: BUILT_IN,
    source_kind: 'marketplace',
  });
});

/**
 * Removing a plugin may say no more about it than installing one did. This is
 * the half that was missed when the rule arrived: the id was withheld on the
 * way in and sent on the way out, which made the printed inventory false.
 */
test('a local uninstall withholds the folders plugin name too', () => {
  const event = new PluginUninstalledEvent(null, 'cursor', custom, 'local');
  assert.equal(event.properties().plugin, null);
  assert.equal(event.properties().source_kind, 'local');
  assert.equal(event.properties().marketplace, 'custom');
});

/**
 * `stage` is null on this arm and is sent anyway: the two failure events are
 * read as one funnel, and a property missing from one arm cannot be grouped by.
 */
test('a failed uninstall carries a null stage rather than omitting it', () => {
  const event = new PluginUninstallFailedEvent(plugin, builtIn, 'marketplace', 'unexpected');
  assert.equal(event.name, 'Context Plugin Uninstall Failed');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    marketplace: BUILT_IN,
    source_kind: 'marketplace',
    stage: null,
    error_kind: 'unexpected',
  });
  assert.ok('stage' in event.properties());
});

/**
 * An id that never validated is a string the user typed, and the one thing a
 * failure event is not allowed to echo. Both failure arms take `PluginId |
 * null` so there is no other way to say it.
 */
test('an unvalidated id travels as null on both failure arms', () => {
  assert.equal(
    new PluginInstallFailedEvent(null, builtIn, 'marketplace', 'resolve', 'user').properties()
      .plugin,
    null,
  );
  assert.equal(
    new PluginUninstallFailedEvent(null, builtIn, 'marketplace', 'user').properties().plugin,
    null,
  );
});

/**
 * The label is the built-in constant or `custom`, never what the user typed -
 * so a differently cased spelling of the built-in marketplace counts as the
 * built-in one and the spelling stays on this machine.
 */
test('a differently cased built-in repo is still the built-in marketplace', () => {
  const cased = MarketplaceLabel.of({ repo: BUILT_IN.toUpperCase(), telemetry });
  assert.equal(cased.toString(), BUILT_IN);
});

test('every property of every event is a primitive', () => {
  const events = [
    new PluginInstalledEvent(plugin, 'cursor', builtIn, 'marketplace', false, 1),
    new PluginInstalledEvent(null, 'cursor', custom, 'local', false, 1),
    new PluginInstallFailedEvent(plugin, custom, 'local', null, 'unexpected'),
    new PluginUninstalledEvent(plugin, 'claude', custom, 'marketplace'),
    new PluginUninstallFailedEvent(plugin, custom, 'marketplace', 'user'),
  ];
  for (const event of events) {
    for (const [key, value] of Object.entries(event.properties())) {
      assert.ok(
        value === null || ['string', 'number', 'boolean'].includes(typeof value),
        `${event.name}.${key} is ${typeof value}, which is not a primitive`,
      );
    }
  }
});
