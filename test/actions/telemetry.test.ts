import test from 'node:test';
import assert from 'node:assert';

import { TelemetryAction } from '../../src/actions/telemetry.js';
import { Failure } from '../../src/types/failure.js';
import { FilePath } from '../../src/types/file/paths.js';
import type { TelemetrySettings } from '../../src/types/ports.js';
import { ok, err, type Result } from '../../src/types/result.js';
import type { TelemetryMode, TelemetryOptOut, TelemetryStatus } from '../../src/types/telemetry.js';

// The action over its port: no file, no environment. What each outcome is said
// as belongs to test/commands/telemetry.test.ts.

const FILE = new FilePath('/home/dev/.context-plugins/telemetry.json');

interface FakeSpec {
  /** What `status()` answers after a write, which is not always what was asked. */
  mode?: TelemetryMode;
  optOut?: TelemetryOptOut | null;
  id?: string | null;
  write?: Result<void, Failure>;
}

/** Records what was written, and answers whatever the spec says the state is. */
function fakeSettings({
  mode = 'on',
  optOut = null,
  id = null,
  write = ok(undefined),
}: FakeSpec = {}) {
  const wrote: boolean[] = [];
  const reads: number[] = [];
  const settings: TelemetrySettings = {
    file: FILE,
    status: (): TelemetryStatus => {
      reads.push(reads.length);
      return { mode, optOut, id, file: FILE };
    },
    setEnabled: (enabled) => {
      wrote.push(enabled);
      return write;
    },
  };
  return { settings, wrote, reads };
}

test('no action named reads as status, and writes nothing', () => {
  const fake = fakeSettings();
  const result = new TelemetryAction(fake.settings).execute({});

  assert.equal(result.isSuccess(), true);
  assert.equal(result.report.verb, 'status');
  assert.deepEqual(fake.wrote, [], 'status is a read');
  assert.equal(result.report.overridden, false, 'nothing was saved, so nothing can override it');
});

test('enable and disable each write the choice they name', () => {
  const enabling = fakeSettings();
  new TelemetryAction(enabling.settings).execute({ action: 'enable' });
  assert.deepEqual(enabling.wrote, [true]);

  const disabling = fakeSettings({ mode: 'off', optOut: 'user' });
  new TelemetryAction(disabling.settings).execute({ action: 'disable' });
  assert.deepEqual(disabling.wrote, [false]);
});

/**
 * The state is read back after the write, because saving a choice does not make
 * it the effective one: `DO_NOT_TRACK`, `CP_TELEMETRY` and either rc file all
 * take precedence, and a run that said "enabled" while sending nothing would be
 * lying to the user about their own machine.
 */
test('a choice a broader switch overrides is reported as overridden', () => {
  const fake = fakeSettings({ mode: 'off', optOut: 'DO_NOT_TRACK' });

  const result = new TelemetryAction(fake.settings).execute({ action: 'enable' });

  assert.equal(result.isSuccess(), true, 'the choice was still saved');
  assert.equal(result.report.overridden, true);
  assert.equal(result.report.status?.optOut, 'DO_NOT_TRACK', 'so the caller can name it');
});

test('a choice nothing overrides is not reported as overridden', () => {
  const fake = fakeSettings({ mode: 'on' });

  const result = new TelemetryAction(fake.settings).execute({ action: 'enable' });

  assert.equal(result.report.overridden, false);
});

// `log` is neither on nor off, so it overrides either choice.
test('CP_TELEMETRY=log overrides both choices', () => {
  for (const action of ['enable', 'disable']) {
    const fake = fakeSettings({ mode: 'log' });
    const result = new TelemetryAction(fake.settings).execute({ action });
    assert.equal(result.report.overridden, true, action);
  }
});

test('a write that fails names the file, and keeps the reason for --verbose', () => {
  const fake = fakeSettings({ write: err(new Failure('EACCES: permission denied')) });

  const result = new TelemetryAction(fake.settings).execute({ action: 'disable' });

  assert.equal(result.isFailed(), true);
  assert.equal(result.exitCode(), 1);
  assert.match(result.failure?.message ?? '', /Could not write .*telemetry\.json\./);
  assert.match(result.failure?.hint ?? '', /CP_TELEMETRY=off in the environment needs no file/);
  assert.equal(result.report.writeError?.message, 'EACCES: permission denied');
  assert.deepEqual(fake.reads, [], 'nothing is read back when nothing was written');
});

test('the hint for a failed enable is about the state directory, not the environment', () => {
  const fake = fakeSettings({ write: err(new Failure('EACCES')) });

  const result = new TelemetryAction(fake.settings).execute({ action: 'enable' });

  assert.match(result.failure?.hint ?? '', /permissions on the state directory/);
});

test('an action this command does not have is refused before anything is read', () => {
  const fake = fakeSettings();

  const result = new TelemetryAction(fake.settings).execute({ action: 'frobnicate' });

  assert.equal(result.isFailed(), true);
  assert.match(result.failure?.message ?? '', /Unknown telemetry action: frobnicate/);
  assert.match(result.failure?.hint ?? '', /telemetry \[status\|enable\|disable\]/);
  assert.deepEqual(fake.reads, [], 'the command line is refused before the state is touched');
  assert.deepEqual(fake.wrote, []);
  assert.equal(result.report.verb, null, 'nothing ran, so there is no verb to report');
});
