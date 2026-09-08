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
  const event = new PluginInstalledEvent(plugin, 'cursor', builtIn, true, 1234);
  assert.equal(event.name, 'Context Plugin Installed');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    harness: 'cursor',
    marketplace: BUILT_IN,
    targets_explicit: true,
    duration_ms: 1234,
  });
});

test('a failed install reports the stage and the kind, and nothing else', () => {
  const event = new PluginInstallFailedEvent(plugin, custom, 'fetch', 'user');
  assert.equal(event.name, 'Context Plugin Install Failed');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    marketplace: 'custom',
    stage: 'fetch',
    error_kind: 'user',
  });
});

test('an uninstall reports one editor and the marketplace', () => {
  const event = new PluginUninstalledEvent(plugin, 'vscode', builtIn);
  assert.equal(event.name, 'Context Plugin Uninstalled');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    harness: 'vscode',
    marketplace: BUILT_IN,
  });
});

/**
 * `stage` is null on this arm and is sent anyway: the two failure events are
 * read as one funnel, and a property missing from one arm cannot be grouped by.
 */
test('a failed uninstall carries a null stage rather than omitting it', () => {
  const event = new PluginUninstallFailedEvent(plugin, builtIn, 'unexpected');
  assert.equal(event.name, 'Context Plugin Uninstall Failed');
  assert.deepEqual(event.properties(), {
    plugin: 'my-sdk',
    marketplace: BUILT_IN,
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
    new PluginInstallFailedEvent(null, builtIn, 'resolve', 'user').properties().plugin,
    null,
  );
  assert.equal(new PluginUninstallFailedEvent(null, builtIn, 'user').properties().plugin, null);
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
    new PluginInstalledEvent(plugin, 'cursor', builtIn, false, 1),
    new PluginInstallFailedEvent(plugin, custom, null, 'unexpected'),
    new PluginUninstalledEvent(plugin, 'claude', custom),
    new PluginUninstallFailedEvent(plugin, custom, 'user'),
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
