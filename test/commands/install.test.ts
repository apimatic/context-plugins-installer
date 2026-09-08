import test from 'node:test';
import assert from 'node:assert';

import { InstallCommand } from '../../src/commands/install.js';
import { createSession } from '../../src/infrastructure/session.js';
import type { InstallRequest } from '../../src/actions/install.js';
import type { ActionResult } from '../../src/actions/action-result.js';
import type { Deps } from '../../src/types/ports.js';
import type { InstallReport } from '../../src/types/reports.js';
import { cleanupAll } from '../helpers.js';
import {
  TARGETS,
  brandFor,
  deps,
  machine,
  pluginSource,
  quietly,
  sinkInto,
  throwsOnInstall,
  withHarness,
  type Machine,
  type Tracked,
} from '../install-fixture.js';

test.after(cleanupAll);

// What `install` reports. The flow itself is the action's (test/install.test.ts
// drives it end to end); this file is only the events, because they are what the
// command exists for and the one thing no output comparison can see.

const REPO = 'context-plugins/plugin-marketplace';

async function install(
  m: Machine,
  d: Deps,
  req: Partial<InstallRequest>,
  events: Tracked[],
): Promise<ActionResult<InstallReport>> {
  const session = createSession({ deps: d, notify: () => {} });
  try {
    return await quietly(() =>
      new InstallCommand(sinkInto(events)).run(
        {
          brand: brandFor(REPO),
          plugin: 'my-sdk',
          targets: TARGETS,
          deps: d,
          pathOpts: m.pathOpts,
          ...req,
        },
        session,
      ),
    );
  } finally {
    await session.cleanup();
  }
}

test('one event per editor the plugin went into, under the id that validated', async () => {
  const events: Tracked[] = [];
  await install(machine(), deps({ repo: REPO, srcDir: pluginSource() }), {}, events);

  assert.deepEqual(
    events.map((e) => [e.name, e.properties.harness]),
    [
      ['Context Plugin Installed', 'cursor'],
      ['Context Plugin Installed', 'vscode'],
    ],
  );
  assert.equal(events[0]?.properties.plugin, 'my-sdk');
  assert.equal(events[0]?.properties.targets_explicit, true);
  assert.equal(typeof events[0]?.properties.duration_ms, 'number');
});

/**
 * A `Failure` the action answered with is the user's to fix - it has a sentence
 * and a hint, and the run has said them. What the event carries is where the
 * run got to and nothing about what went wrong, because a message can quote a
 * repository or a plugin the user typed.
 */
test('a failure the action answered with is reported as the user, with its stage', async () => {
  const events: Tracked[] = [];
  const result = await install(
    machine(),
    deps({ repo: REPO, srcDir: pluginSource() }),
    { plugin: 'no-such-sdk' },
    events,
  );

  assert.equal(result.isFailed(), true);
  assert.deepEqual(
    events.map((e) => e.name),
    ['Context Plugin Install Failed'],
  );
  assert.equal(events[0]?.properties.error_kind, 'user');
  assert.equal(events[0]?.properties.stage, 'resolve');
  assert.equal(events[0]?.properties.plugin, 'no-such-sdk');
  assert.ok(!JSON.stringify(events[0]).includes('not listed'), 'the message stays home');
});

// An id this program rejected is a string the user typed, and the report cannot
// hold one: the action validates before it builds the report at all.
test('an id that never validated travels as null', async () => {
  const events: Tracked[] = [];
  const result = await install(
    machine(),
    deps({ repo: REPO, srcDir: pluginSource() }),
    { plugin: '../etc' },
    events,
  );

  assert.equal(result.report.plugin, null);
  assert.equal(events[0]?.properties.plugin, null);
  assert.equal(events[0]?.properties.error_kind, 'user');
});

/**
 * A throw out of an action is a bug in this program, which is the one thing a
 * released build wants counted separately - so it is `unexpected`, it reports
 * the stage it reached, and the throw carries on out to the router.
 */
test('a throw out of the action is unexpected, and still leaves the run', async () => {
  const events: Tracked[] = [];
  const m = machine();
  const d = deps({ repo: REPO, srcDir: pluginSource() });

  await assert.rejects(
    withHarness('cursor', throwsOnInstall('disk on fire'), () =>
      install(m, d, { targets: ['cursor'] }, events),
    ),
    /disk on fire/,
  );

  assert.deepEqual(
    events.map((e) => e.name),
    ['Context Plugin Install Failed'],
  );
  assert.equal(events[0]?.properties.error_kind, 'unexpected');
  assert.equal(events[0]?.properties.stage, 'install');
  assert.equal(events[0]?.properties.plugin, 'my-sdk', 'the id it was working on survives');
  assert.ok(!JSON.stringify(events[0]).includes('disk on fire'));
});

// A run that installed nothing reports no install; the failure is the whole of
// what happened.
test('no editor to install into reports the failure alone', async () => {
  const events: Tracked[] = [];
  const m = machine();
  await install(m, deps({ repo: REPO, srcDir: pluginSource() }), { targets: ['claude'] }, events);

  assert.deepEqual(
    events.map((e) => e.name),
    ['Context Plugin Install Failed'],
  );
  assert.equal(events[0]?.properties.stage, 'harnesses');
});
