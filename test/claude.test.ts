import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as claude from '../src/harness/claude.js';
import type { Env } from '../src/types/env.js';
import type { HarnessContext, HarnessOpts } from '../src/types/harness.js';
import type { RunCommand, RunResult } from '../src/types/ports.js';
import { UserError } from '../src/util.js';
import { tmpDir, cleanupAll, silenceConsole } from './helpers.js';

test.after(cleanupAll);

const REPO = 'apimatic/context-plugins';
const CTX: HarnessContext = { plugin: 'xero-sdk', marketplace: 'context-plugins', repo: REPO };

/** A PATH with a `claude` on it, whatever the platform's executable rules are. */
function withClaude(): Env {
  const dir = tmpDir('cp-bin-');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
  return { PATH: dir, PATHEXT: '.CMD' };
}

type FakeCli = RunCommand & { calls: string[] };

/** A fake `claude`: `routes` maps a command-line prefix to its result; every call is recorded. */
function fakeCli(routes: Record<string, Partial<RunResult>>): FakeCli {
  const calls: string[] = [];
  const run = async (_file: string, args: string[]): Promise<RunResult> => {
    const line = args.join(' ');
    calls.push(line);
    const hit = Object.keys(routes).find((k) => line.startsWith(k));
    const res = (hit && routes[hit]) || { code: 0 };
    return { code: res.code || 0, stdout: res.stdout || '', stderr: res.stderr || '' };
  };
  return Object.assign(run, { calls });
}

const listing = (entries: unknown): Partial<RunResult> => ({
  code: 0,
  stdout: JSON.stringify(entries),
});

const opts = (run: RunCommand): HarnessOpts => ({ env: withClaude(), run });

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const con = silenceConsole();
  try {
    return await fn();
  } finally {
    con.restore();
  }
}

test('an already-registered marketplace is updated, not re-added', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([{ name: 'context-plugins', repo: REPO }]),
  });

  assert.equal(await quietly(() => claude.install(CTX, opts(run))), true);

  assert.ok(
    run.calls.includes('plugin marketplace update context-plugins'),
    `expected an update; ran: ${run.calls.join(' | ')}`,
  );
  assert.ok(
    !run.calls.some((c) => c.startsWith('plugin marketplace add')),
    'must not re-add a marketplace that is already there',
  );
  assert.ok(run.calls.includes('plugin install xero-sdk@context-plugins --scope user'));
});

test('an existing entry is updated under the name Claude knows it by', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([
      { name: 'other', repo: 'someone/else' },
      { name: 'apimatic-plugins', url: `https://github.com/${REPO}.git` },
    ]),
  });

  await quietly(() => claude.install(CTX, opts(run)));

  assert.ok(run.calls.includes('plugin marketplace update apimatic-plugins'));
  assert.ok(run.calls.includes('plugin install xero-sdk@apimatic-plugins --scope user'));
});

test('an unregistered marketplace is added', async () => {
  const run = fakeCli({ 'plugin marketplace list': listing([]) });

  await quietly(() => claude.install(CTX, opts(run)));

  assert.ok(run.calls.includes(`plugin marketplace add ${REPO}`));
  assert.ok(run.calls.includes('plugin install xero-sdk@context-plugins --scope user'));
});

test('a stale local copy is refreshed and the install retried', async () => {
  let attempt = 0;
  const run = fakeCli({ 'plugin marketplace list': listing([]) });
  const wrapped: FakeCli = Object.assign(
    async (file: string, args: string[]): Promise<RunResult> => {
      const res = await run(file, args);
      if (args[1] === 'install') {
        attempt += 1;
        if (attempt === 1) {
          return {
            code: 1,
            stdout: '',
            stderr: 'Plugin "xero-sdk" not found in marketplace "context-plugins".',
          };
        }
      }
      return res;
    },
    { calls: run.calls },
  );

  assert.equal(await quietly(() => claude.install(CTX, opts(wrapped))), true);

  assert.equal(attempt, 2, 'the install should be retried once');
  assert.ok(run.calls.includes('plugin marketplace update context-plugins'));
});

test('a marketplace that cannot be listed is still refreshed before installing', async () => {
  // An older CLI has no --json listing, so `add` failing is all we have to go on.
  const run = fakeCli({
    'plugin marketplace list': { code: 1, stderr: 'unknown option --json' },
    'plugin marketplace add': { code: 1, stderr: "Marketplace 'context-plugins' already exists" },
  });

  await quietly(() => claude.install(CTX, opts(run)));

  assert.ok(run.calls.includes('plugin marketplace update context-plugins'));
  assert.ok(run.calls.includes('plugin install xero-sdk@context-plugins --scope user'));
});

test('a different marketplace under the same name is reported, not installed into', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([{ name: 'context-plugins', repo: 'someone/else' }]),
  });

  await assert.rejects(
    () => quietly(() => claude.install(CTX, opts(run))),
    (err) =>
      err instanceof UserError &&
      /marketplace named 'context-plugins', from someone\/else/.test(err.message),
  );
  assert.ok(!run.calls.some((c) => c.startsWith('plugin install')));
});

test('a same-named entry with no visible source is refreshed, not refused', async () => {
  // A marketplace added from a local directory lists no repo to compare against.
  const run = fakeCli({
    'plugin marketplace list': listing([
      { name: 'context-plugins', path: 'C:\\Users\\me\\marketplaces\\context-plugins' },
    ]),
  });

  assert.equal(await quietly(() => claude.install(CTX, opts(run))), true);
  assert.ok(run.calls.includes('plugin marketplace update context-plugins'));
  assert.ok(!run.calls.some((c) => c.startsWith('plugin marketplace add')));
});

test('the repo is matched however the listing spells its source', async () => {
  for (const entry of [
    { name: 'mp', repo: REPO },
    { name: 'mp', url: `git@github.com:${REPO}.git` },
    { name: 'mp', source: { source: 'github', repo: REPO } },
    { name: 'mp', source: `https://github.com/${REPO}` },
  ]) {
    const run = fakeCli({ 'plugin marketplace list': listing([entry]) });
    await quietly(() => claude.install(CTX, opts(run)));
    assert.ok(
      run.calls.includes('plugin marketplace update mp'),
      `unmatched entry: ${JSON.stringify(entry)}`,
    );
  }
});

test('an update failure does not stop the install', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([{ name: 'context-plugins', repo: REPO }]),
    'plugin marketplace update': { code: 1, stderr: 'network unreachable' },
  });

  assert.equal(await quietly(() => claude.install(CTX, opts(run))), true);
  assert.ok(run.calls.includes('plugin install xero-sdk@context-plugins --scope user'));
});

test('a genuinely missing plugin still fails, with the marketplace named', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([{ name: 'context-plugins', repo: REPO }]),
    'plugin install': {
      code: 1,
      stderr: 'Plugin "nope" not found in marketplace "context-plugins".',
    },
  });

  await assert.rejects(
    () => quietly(() => claude.install({ ...CTX, plugin: 'nope' }, opts(run))),
    (err) =>
      err instanceof UserError && /not in marketplace 'context-plugins'/.test(err.hint || ''),
  );
});

test('uninstall targets the name Claude knows the marketplace by', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([{ name: 'apimatic-plugins', repo: REPO }]),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'removed');
  assert.ok(run.calls.includes('plugin uninstall xero-sdk@apimatic-plugins --scope user'));
});

// The bug this guards: a record that has drifted from what Claude actually has.
// Reporting it as a failure leaves the row unremovable and `update` failing on
// it forever, so an uninstall Claude answers with "not installed" is `absent`.
const NOT_INSTALLED: Partial<RunResult> = {
  code: 1,
  stderr: 'Plugin "xero-sdk@context-plugins" not found in installed plugins',
};

const plugins = (ids: unknown[], scope = 'user'): Partial<RunResult> => ({
  code: 0,
  stdout: JSON.stringify(ids.map((id) => ({ id, scope, enabled: true }))),
});

test('a plugin Claude does not have is absent, not a failed uninstall', async () => {
  const run = fakeCli({
    'plugin uninstall': NOT_INSTALLED,
    'plugin list': plugins(['other-sdk@context-plugins']),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'absent');
});

test('a plugin Claude still lists is a failure, whatever the message says', async () => {
  const run = fakeCli({
    'plugin uninstall': NOT_INSTALLED,
    'plugin list': plugins(['xero-sdk@context-plugins']),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

// The id is `plugin@marketplace`, and the marketplace half is whatever name
// Claude filed it under. Comparing the whole id would read a name this build
// could not resolve as proof of absence and delete a live record.
test('a marketplace Claude knows by another name is not absence', async () => {
  const run = fakeCli({
    'plugin marketplace list': { code: 1 }, // nothing to resolve the name from
    'plugin uninstall': NOT_INSTALLED,
    'plugin list': plugins(['xero-sdk@apimatic-plugins']),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

// Everything here installs and uninstalls at user scope, so a project-scope
// copy is not what this record is about - and must not keep it stuck.
test('a copy at another scope leaves the user-scope record clearable', async () => {
  const run = fakeCli({
    'plugin uninstall': NOT_INSTALLED,
    'plugin list': plugins(['xero-sdk@context-plugins'], 'project'),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'absent');
});

test('a listing that does not say the scope counts as possibly ours', async () => {
  const run = fakeCli({
    'plugin uninstall': NOT_INSTALLED,
    'plugin list': { code: 0, stdout: JSON.stringify([{ id: 'xero-sdk@context-plugins' }]) },
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

test('absence falls back to the message when the CLI cannot list plugins', async () => {
  const stale = fakeCli({ 'plugin uninstall': NOT_INSTALLED, 'plugin list': { code: 1 } });
  assert.equal(await quietly(() => claude.uninstall(CTX, opts(stale))), 'absent');

  const broken = fakeCli({
    'plugin uninstall': { code: 1, stderr: 'EACCES: permission denied' },
    'plugin list': { code: 1 },
  });
  assert.equal(await quietly(() => claude.uninstall(CTX, opts(broken))), 'failed');
});

// The fallback pattern has to be about a plugin. A bare "is not installed" also
// matches a marketplace's own failure, which would clear a record off a real error.
// The message that broke the previous pattern: `plugin\b` was satisfied by the
// hyphen in `plugin-marketplace`, and the plugin id is in the text too, so
// neither the regex nor the id guard held. Nothing about "is not installed" can
// be trusted to be about a plugin, so no alternative is built on it.
test('a marketplace failure is not read as the plugin being absent', async () => {
  for (const stderr of [
    'Failed to uninstall plugin "xero-sdk@plugin-marketplace":' +
      " Marketplace 'plugin-marketplace' is not installed",
    "plugin marketplace 'context-plugins' is not installed",
    'xero-sdk is not installed',
  ]) {
    const run = fakeCli({ 'plugin uninstall': { code: 1, stderr }, 'plugin list': { code: 1 } });
    assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed', stderr);
  }
});

// An unrecognised scope word must not be the thing that reads as absence: the
// same conservatism the id and the marketplace name already get.
test('a scope this build has never seen counts as possibly ours', async () => {
  const run = fakeCli({
    'plugin uninstall': NOT_INSTALLED,
    'plugin list': plugins(['xero-sdk@context-plugins'], 'Global'),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

// Absence is the one conclusion this listing is read for, so it has to be read
// WHOLE. A row shape the build cannot parse used to be filtered away before the
// guard could see it, and an all-unreadable listing then looked like "nothing is
// installed" - clearing the record for a plugin Claude still had.
test('a listing of a shape this build cannot parse is unknown, not absence', async () => {
  const run = fakeCli({
    'plugin uninstall': { code: 1, stderr: 'boom' },
    'plugin list': { code: 0, stdout: JSON.stringify(['xero-sdk@context-plugins', 'other@x']) },
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

test('one unreadable row makes the whole listing unknown', async () => {
  const run = fakeCli({
    'plugin uninstall': { code: 1, stderr: 'boom' },
    // A newer CLI renamed `id` on some rows but not others.
    'plugin list': {
      code: 0,
      stdout: JSON.stringify([
        { name: 'xero-sdk', scope: 'user' },
        { id: 'other@x', scope: 'user' },
      ]),
    },
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

test('an empty listing is still proof that nothing is installed', async () => {
  const run = fakeCli({ 'plugin uninstall': NOT_INSTALLED, 'plugin list': plugins([]) });
  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'absent');
});

test('a listing whose rows carry no id is unknown, not proof of absence', async () => {
  const run = fakeCli({
    'plugin uninstall': { code: 1, stderr: 'EACCES: permission denied' },
    // A future CLI moves the id; reading that as "nothing installed" would
    // clear a record for a plugin that is still there.
    'plugin list': { code: 0, stdout: JSON.stringify([{ name: 'xero-sdk' }]) },
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

// A skip, not a failure: Claude Code is not here to fail. The record still
// survives - nothing could be established either way - but the run does not.
test('no claude to ask is a skip, and the record survives it', async () => {
  const run = fakeCli({});
  assert.equal(await quietly(() => claude.uninstall(CTX, { env: { PATH: '' }, run })), 'skipped');
  assert.equal(run.calls.length, 0);
});

test('a real uninstall failure is a failure, not a skip', async () => {
  const run = fakeCli({
    'plugin uninstall': { code: 1, stderr: 'EACCES: permission denied' },
    'plugin list': plugins(['xero-sdk@context-plugins']),
  });

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), 'failed');
});

test('no claude on PATH is a skip, not a failure', async () => {
  const run = fakeCli({});
  assert.equal(await quietly(() => claude.install(CTX, { env: { PATH: '' }, run })), false);
  assert.equal(run.calls.length, 0);
});

test('junk entries in the marketplace listing are ignored, not crashed on', async () => {
  const run = fakeCli({
    'plugin marketplace list': listing([null, 'junk', 42, { name: 'context-plugins', repo: REPO }]),
  });

  assert.equal(await quietly(() => claude.install(CTX, opts(run))), true);

  assert.ok(
    run.calls.includes('plugin marketplace update context-plugins'),
    `the real entry is still found among the junk; ran: ${run.calls.join(' | ')}`,
  );
});
