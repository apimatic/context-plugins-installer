import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';

import { UninstallCommand } from '../../src/commands/uninstall.js';
import * as paths from '../../src/infrastructure/paths.js';
import { installPlugin } from '../../src/install.js';
import type { Deps } from '../../src/types/ports.js';
import { cleanupAll } from '../helpers.js';
import {
  TARGETS,
  brandFor,
  deps,
  machine,
  pluginSource,
  quietly,
  sinkInto,
  withHarness,
  type Machine,
  type Tracked,
} from '../install-fixture.js';

test.after(cleanupAll);

// What `uninstall` reports. Which records it corrects and which lines it says
// are the action's and the decision's (test/application/uninstall-decision.ts
// walks that space); these are the events.

const REPO = 'context-plugins/plugin-marketplace';

/** A machine with the plugin installed into both file-copying editors. */
async function installed(): Promise<{ m: Machine; d: Deps }> {
  const m = machine();
  const d = deps({ repo: REPO, srcDir: pluginSource() });
  await quietly(() =>
    installPlugin({
      brand: brandFor(REPO),
      plugin: 'my-sdk',
      targets: TARGETS,
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );
  return { m, d };
}

const uninstall = (m: Machine, d: Deps, events: Tracked[], plugin = 'my-sdk') =>
  quietly(() =>
    new UninstallCommand(sinkInto(events)).run({
      brand: brandFor(REPO),
      plugin,
      targets: TARGETS,
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );

test('one event per editor it actually removed from', async () => {
  const { m, d } = await installed();
  const events: Tracked[] = [];
  await uninstall(m, d, events);

  assert.deepEqual(
    events.map((e) => [e.name, e.properties.harness, e.properties.plugin]),
    [
      ['Context Plugin Uninstalled', 'cursor', 'my-sdk'],
      ['Context Plugin Uninstalled', 'vscode', 'my-sdk'],
    ],
  );
  assert.equal(events[0]?.properties.marketplace, REPO);
});

/**
 * A partial uninstall is still work done, and the order says so: what was
 * removed is reported before the failure that ended the run. Reading the
 * failure alone would count the removals as never having happened.
 */
test('a partial failure reports the removals first, then the failure', async () => {
  const { m, d } = await installed();
  const events: Tracked[] = [];
  const result = await withHarness(
    'vscode',
    {
      uninstall: async () => {
        throw new Error('editor is running');
      },
    },
    () => uninstall(m, d, events),
  );

  assert.equal(result.isFailed(), true);
  assert.deepEqual(
    events.map((e) => [e.name, e.properties.harness ?? null]),
    [
      ['Context Plugin Uninstalled', 'cursor'],
      ['Context Plugin Uninstall Failed', null],
    ],
  );
  const failure = events[1]?.properties;
  assert.equal(failure?.error_kind, 'user', 'the action answered rather than threw');
  assert.equal(
    failure?.stage,
    null,
    'uninstall has no stages, and says so rather than omitting it',
  );
  assert.ok(!JSON.stringify(events).includes('editor is running'), 'the message stays home');
});

/**
 * The one thing that can throw past the action's own per-editor catch: the
 * record write at the end. It is deliberately not in a `finally`, so a write
 * failure on the success path cannot pass silently - which makes it the
 * `unexpected` arm this command's catch exists for. Blocked here by taking the
 * name the atomic write uses for its temporary file, which is the one portable
 * way to fail a write whose directory is fine.
 */
test('a record write that fails is unexpected, and the run still throws', async () => {
  const { m, d } = await installed();
  const manifest = paths.manifestPath(m.pathOpts).toString();
  fs.mkdirSync(`${manifest}.${process.pid}.tmp`);

  const events: Tracked[] = [];
  await assert.rejects(uninstall(m, d, events), /EISDIR|EPERM|EACCES|illegal operation/i);

  assert.deepEqual(
    events.map((e) => e.name),
    ['Context Plugin Uninstall Failed'],
    'the removals are not reported: the run never got to say they stuck',
  );
  assert.equal(events[0]?.properties.error_kind, 'unexpected');
  assert.equal(events[0]?.properties.plugin, 'my-sdk', 'the id it was working on survives');
});

test('an id that never validated travels as null', async () => {
  const { m, d } = await installed();
  const events: Tracked[] = [];
  const result = await uninstall(m, d, events, '../etc');

  assert.equal(result.isFailed(), true);
  assert.deepEqual(
    events.map((e) => [e.name, e.properties.plugin]),
    [['Context Plugin Uninstall Failed', null]],
  );
});
