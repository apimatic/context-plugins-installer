import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as claude from '../src/harness/claude.js';
import type { Env, HarnessContext, HarnessOpts, RunCommand, RunResult } from '../src/types.js';
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

/**
 * A fake `claude`: `routes` maps a command line to its result, and every call is
 * recorded so a test can assert what the installer decided to run.
 */
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
  // A marketplace added from a local directory lists no repo to compare against;
  // guessing "someone else's" would block an install that is probably fine.
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

  assert.equal(await quietly(() => claude.uninstall(CTX, opts(run))), true);
  assert.ok(run.calls.includes('plugin uninstall xero-sdk@apimatic-plugins --scope user'));
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
