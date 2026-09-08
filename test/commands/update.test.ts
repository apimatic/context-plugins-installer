import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';

import { UpdateCommand } from '../../src/commands/update.js';
import * as paths from '../../src/infrastructure/paths.js';
import { cleanupAll } from '../helpers.js';
import {
  brandFor,
  deps,
  installPlugin,
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

// What `update` reports, per row shape. The action's own tests cover which rows
// it refuses and refreshes (test/actions/update.test.ts); these are the events,
// which is the whole of what a command adds - and the one thing the per-command
// output comparisons cannot see, since nothing about them reaches the terminal.

const REPO = 'context-plugins/plugin-marketplace';

/** A machine with one plugin recorded for Cursor, ready to be updated. */
async function recorded(plugin = 'my-sdk'): Promise<{ m: Machine; d: ReturnType<typeof deps> }> {
  const m = machine();
  const d = deps({ repo: REPO, plugin, srcDir: pluginSource(plugin) });
  await quietly(() =>
    installPlugin({
      brand: brandFor(REPO),
      plugin,
      targets: ['cursor'],
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );
  return { m, d };
}

const update = async (m: Machine, d: object, events: Tracked[]): Promise<void> => {
  await quietly(() =>
    new UpdateCommand(sinkInto(events)).run({
      brand: brandFor(REPO),
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );
};

test('a refreshed row reports one event per editor, with the marketplace that row records', async () => {
  const { m, d } = await recorded();
  const events: Tracked[] = [];
  await update(m, d, events);

  assert.deepEqual(
    events.map((e) => [e.name, e.properties.harness]),
    [['Context Plugin Installed', 'cursor']],
  );
  assert.equal(events[0]?.properties.plugin, 'my-sdk');
  assert.equal(events[0]?.properties.marketplace, REPO);
});

/**
 * The regression this test exists for: `UpdateAction` catches a throw per row,
 * so the command's own catch never runs for one - and reporting every failed
 * row as `user` made a bug in this program indistinguishable from a plugin the
 * user misspelled. Measured against the pre-Phase-5 build, which said
 * `unexpected` here.
 */
test('a row whose install threw is reported as unexpected, with the stage it reached', async () => {
  const { m, d } = await recorded();
  const events: Tracked[] = [];
  await withHarness('cursor', throwsOnInstall('disk on fire'), () => update(m, d, events));

  assert.deepEqual(
    events.map((e) => e.name),
    ['Context Plugin Install Failed'],
  );
  const [event] = events;
  assert.equal(event?.properties.error_kind, 'unexpected');
  assert.equal(event?.properties.stage, 'install');
  assert.equal(event?.properties.plugin, 'my-sdk');
  assert.equal(event?.properties.marketplace, REPO);
  assert.ok(!JSON.stringify(event).includes('disk on fire'), 'the message stays home');
});

/**
 * A record this build cannot read is not an install that failed: nothing was
 * installed, nothing was reached, and the row's marketplace is not known well
 * enough to name. The pre-Phase-5 build sent nothing for one - it never reached
 * an install to report on - and reporting one as `custom` said the opposite of
 * the truth about a row whose repo is the built-in marketplace.
 */
test('a row this build cannot read reports nothing, and still fails the run', async () => {
  const { m, d } = await recorded();
  const file = paths.manifestPath(m.pathOpts).toString();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.plugins.push({ plugin: 'future-sdk', repo: REPO, marketplace: 'apimatic', targets: ['zed'] });
  fs.writeFileSync(file, JSON.stringify(raw));

  const events: Tracked[] = [];
  const result = await quietly(() =>
    new UpdateCommand(sinkInto(events)).run({
      brand: brandFor(REPO),
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(
    result.report.failed.map((f) => f.plugin),
    ['future-sdk'],
    'the row still fails the run',
  );
  assert.deepEqual(
    events.map((e) => [e.name, e.properties.plugin]),
    [['Context Plugin Installed', 'my-sdk']],
    'and only the row that actually updated is reported',
  );
});

// Nothing was asked of it, so there is nothing to report either - the same
// reason it is not a failure.
test('a row with no editor on this machine reports nothing', async () => {
  const { m, d } = await recorded();
  fs.rmSync(m.pathOpts.env.CP_CURSOR_DIR, { recursive: true, force: true });

  const events: Tracked[] = [];
  const result = await quietly(() =>
    new UpdateCommand(sinkInto(events)).run({
      brand: brandFor(REPO),
      deps: d,
      pathOpts: m.pathOpts,
    }),
  );

  assert.deepEqual(result.report.failed, []);
  assert.deepEqual(events, []);
});
