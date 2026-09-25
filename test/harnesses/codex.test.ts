import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CodexHarness } from '../../src/harnesses/codex.js';
import { registryClient } from '../../src/infrastructure/github-registry-client.js';
import { createSession } from '../../src/infrastructure/session.js';
import { sourceFetcher } from '../../src/infrastructure/source-fetcher.js';
import * as paths from '../../src/infrastructure/paths.js';
import type { Env } from '../../src/types/env.js';
import { DirectoryPath, rulesFor } from '../../src/types/file/paths.js';
import type { HarnessContext, HarnessEvent, HarnessOpts } from '../../src/types/harness.js';
import { DirectoryMarketplace, RepoMarketplace } from '../../src/types/marketplace-origin.js';
import type { RunResult } from '../../src/types/ports.js';
import { ok } from '../../src/types/result.js';
import { cleanupAll, outcome, portsFor, runnerFor, stubFetch, tmpDir } from '../helpers.js';

test.after(cleanupAll);

// The conversation with the `codex` CLI, which is what this harness is: policy
// over exit codes, listings and the one folder a removal deletes. The listing
// shapes below are what codex-cli 0.149.1 and 0.156.1 print for `--json`; the
// CI job `codex` asserts the same against whatever Codex is current.

const codex = new CodexHarness();
const REPO = 'context-plugins/plugin-marketplace';
const GIT_URL = `https://github.com/${REPO}.git`;

const CTX: HarnessContext = {
  plugin: 'xero-sdk',
  origin: new RepoMarketplace(REPO, 'context-plugins'),
  listener: () => {},
};

function recording(over: Partial<HarnessContext> = {}) {
  const events: HarnessEvent[] = [];
  return {
    events,
    kinds: (): string[] => events.map((e) => e.kind),
    ctx: { ...CTX, ...over, listener: (e: HarnessEvent) => events.push(e) },
  };
}

type Route = Partial<RunResult> | ((line: string) => Partial<RunResult>);

interface Fake {
  opts: HarnessOpts;
  calls: string[];
  home: string;
}

/**
 * A `codex` on PATH, a sandboxed CODEX_HOME, and a fake CLI behind it: `routes`
 * maps a command-line prefix to a result, or to a function for one with a side
 * effect. An unrouted call exits 0 with nothing to say.
 */
function fake(routes: Record<string, Route> = {}): Fake {
  const bin = tmpDir('cp-bin-');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\n');
  const home = tmpDir('cp-codex-home-');
  const env: Env = { PATH: bin, PATHEXT: '.CMD', CODEX_HOME: home };
  const calls: string[] = [];
  const run = async (_file: string, args: string[]): Promise<RunResult> => {
    const line = args.join(' ');
    calls.push(line);
    const hit = Object.keys(routes).find((k) => line.startsWith(k));
    const route = hit ? routes[hit] : undefined;
    const res = typeof route === 'function' ? route(line) : route || {};
    return { code: res.code || 0, stdout: res.stdout || '', stderr: res.stderr || '' };
  };
  return { opts: { env, runner: runnerFor(run, env) }, calls, home };
}

const json = (value: unknown): Partial<RunResult> => ({ code: 0, stdout: JSON.stringify(value) });

const gitEntry = (name: string, source = GIT_URL) => ({
  name,
  root: `/home/dev/.codex/.tmp/marketplaces/${name}`,
  marketplaceSource: { sourceType: 'git', source },
});

const marketplaces = (...entries: unknown[]) => json({ marketplaces: entries });

const installed = (...ids: string[]) =>
  json({
    installed: ids.map((pluginId) => ({ pluginId, installed: true, enabled: true })),
    available: [],
  });

/** Codex's cache folder for a plugin, as a real `plugin add` leaves it. */
function cache(f: Fake, marketplace: string, plugin: string): string {
  const dir = path.join(f.home, 'plugins', 'cache', marketplace, plugin, '0.1.0');
  fs.mkdirSync(dir, { recursive: true });
  return path.dirname(dir);
}

test('it installs from the marketplace itself, so it needs no plugin files', () => {
  assert.equal(codex.needsSource, false);
  // Two questions, asserted apart: what an editor is addressed by decides who
  // the generated marketplace is staged for, and it is not `!needsSource`.
  assert.equal(codex.installsFromMarketplace, true);
});

test('detect is the CLI on PATH, and says where it looked', () => {
  assert.equal(codex.detect(fake().opts), true);
  const env: Env = { PATH: tmpDir('cp-empty-bin-'), PATHEXT: '.CMD' };
  assert.equal(
    codex.detect({
      env,
      runner: runnerFor(async () => ({ code: 0, stdout: '', stderr: '' }), env),
    }),
    false,
  );
  assert.equal(codex.location(), 'codex on PATH');
});

test('without the CLI, install is a skip that says why', async () => {
  const env: Env = { PATH: tmpDir('cp-empty-bin-'), PATHEXT: '.CMD' };
  const r = recording();
  const res = await codex.install(r.ctx, {
    env,
    runner: runnerFor(async () => ({ code: 0, stdout: '', stderr: '' }), env),
  });
  assert.equal(outcome(res), 'skipped');
  assert.deepEqual(r.kinds(), ['cli-missing']);
});

test('an unregistered marketplace is added, then the plugin installed from it', async () => {
  const f = fake({ 'plugin marketplace list': marketplaces() });
  const r = recording();

  assert.equal(outcome(await codex.install(r.ctx, f.opts)), 'installed');

  assert.ok(f.calls.includes(`plugin marketplace add ${REPO}`), f.calls.join(' | '));
  assert.ok(f.calls.includes('plugin add xero-sdk@context-plugins'));
  assert.ok(
    !f.calls.some((c) => c.startsWith('plugin marketplace upgrade')),
    'a fresh add is current',
  );
  assert.deepEqual(r.kinds(), ['marketplace-added', 'plugin-installed', 'reload']);
});

test('an already-registered git marketplace is upgraded, not re-added', async () => {
  const f = fake({ 'plugin marketplace list': marketplaces(gitEntry('context-plugins')) });
  const r = recording();

  assert.equal(outcome(await codex.install(r.ctx, f.opts)), 'installed');

  assert.ok(f.calls.includes('plugin marketplace upgrade context-plugins'));
  assert.ok(!f.calls.some((c) => c.startsWith('plugin marketplace add')));
  assert.deepEqual(r.kinds(), [
    'marketplace-registered',
    'marketplace-upgraded',
    'plugin-installed',
    'reload',
  ]);
});

test('a marketplace Codex knows by another name is installed into under that name', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(
      gitEntry('other', 'https://github.com/someone/else.git'),
      gitEntry('apimatic-plugins'),
    ),
  });
  const r = recording();

  await codex.install(r.ctx, f.opts);

  assert.ok(f.calls.includes('plugin marketplace upgrade apimatic-plugins'));
  assert.ok(f.calls.includes('plugin add xero-sdk@apimatic-plugins'));
  assert.equal(r.kinds()[0], 'marketplace-renamed');
});

test('the repo is matched however Codex spells the git source', async () => {
  for (const source of [GIT_URL, `https://github.com/${REPO}`, `git@github.com:${REPO}.git`]) {
    const f = fake({ 'plugin marketplace list': marketplaces(gitEntry('mp', source)) });
    await codex.install(CTX, f.opts);
    assert.ok(f.calls.includes('plugin add xero-sdk@mp'), `unmatched source: ${source}`);
  }
});

test('a same-named marketplace from somewhere else is refused, not installed into', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(
      gitEntry('context-plugins', 'https://github.com/someone/else.git'),
    ),
  });

  const res = await codex.install(CTX, f.opts);

  assert.equal(res.ok, false);
  assert.match(
    res.ok ? '' : res.error.message,
    /named 'context-plugins', from https:\/\/github.com\/someone\/else.git/,
  );
  assert.match(
    res.ok ? '' : res.error.hint || '',
    /codex plugin marketplace remove context-plugins/,
  );
  assert.ok(!f.calls.some((c) => c.startsWith('plugin marketplace add')));
  assert.ok(!f.calls.some((c) => c.startsWith('plugin add')));
});

test('a marketplace Codex will not register fails the run with what Codex said', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(),
    'plugin marketplace add': {
      code: 1,
      stderr: 'Error: marketplace root does not contain a supported manifest',
    },
  });

  const res = await codex.install(CTX, f.opts);

  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error.message, /does not contain a supported manifest/);
  assert.ok(!f.calls.some((c) => c.startsWith('plugin add')), 'nothing to install into');
});

test('a listing Codex cannot give still reaches the add, which is safe to repeat', async () => {
  const f = fake({
    'plugin marketplace list': { code: 1, stderr: 'failed to load marketplace(s)' },
  });

  assert.equal(outcome(await codex.install(CTX, f.opts)), 'installed');
  assert.ok(f.calls.includes(`plugin marketplace add ${REPO}`));
  assert.ok(f.calls.includes('plugin add xero-sdk@context-plugins'));
});

test('a stale snapshot is upgraded and the install retried once', async () => {
  let upgrades = 0;
  let adds = 0;
  const f = fake({
    'plugin marketplace list': marketplaces(gitEntry('context-plugins')),
    // The first upgrade fails, so the snapshot is not known to be current.
    'plugin marketplace upgrade': () => (++upgrades === 1 ? { code: 1, stderr: 'network' } : {}),
    'plugin add': () =>
      ++adds === 1
        ? {
            code: 1,
            stderr: 'Error: plugin `xero-sdk` was not found in marketplace `context-plugins`',
          }
        : {},
  });
  const r = recording();

  assert.equal(outcome(await codex.install(r.ctx, f.opts)), 'installed');
  assert.equal(adds, 2);
  assert.ok(r.kinds().includes('plugin-stale'));
});

test('a genuinely missing plugin fails, naming the marketplace and a runnable command', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(gitEntry('context-plugins')),
    'plugin add': {
      code: 1,
      stderr: 'Error: plugin `nope` was not found in marketplace `context-plugins`',
    },
  });

  const res = await codex.install({ ...CTX, plugin: 'nope' }, f.opts);

  assert.equal(res.ok, false);
  assert.match(
    res.ok ? '' : res.error.message,
    /codex plugin add nope@context-plugins failed \(exit 1\)/,
  );
  assert.match(
    res.ok ? '' : res.error.hint || '',
    /not in marketplace 'context-plugins'. Run `npx context-plugins list`/,
  );
  // The snapshot was just upgraded, so a retry would ask the same question twice.
  assert.equal(f.calls.filter((c) => c.startsWith('plugin add')).length, 1);
});

test('the generated marketplace is found by its directory and never upgraded', async () => {
  const dir = new DirectoryPath('C:\\Users\\dev\\.context-plugins\\marketplace', rulesFor('win32'));
  const origin = new DirectoryMarketplace(dir, 'context-plugins-local');
  // A local marketplace lists only its root; plugin listings add the verbatim prefix.
  for (const entry of [
    { name: 'context-plugins-local', root: dir.toString() },
    {
      name: 'context-plugins-local',
      root: 'elsewhere',
      marketplaceSource: { sourceType: 'local', source: `\\\\?\\${dir.toString()}` },
    },
  ]) {
    const f = fake({ 'plugin marketplace list': marketplaces(entry) });
    const r = recording({ origin });
    assert.equal(outcome(await codex.install(r.ctx, f.opts)), 'installed');
    assert.ok(
      !f.calls.some((c) => c.startsWith('plugin marketplace upgrade')),
      'upgrade refuses a local one',
    );
    assert.ok(!f.calls.some((c) => c.startsWith('plugin marketplace add')));
    assert.ok(f.calls.includes('plugin add xero-sdk@context-plugins-local'), JSON.stringify(entry));
  }
});

test('an unregistered generated marketplace is added by its path', async () => {
  const dir = new DirectoryPath(tmpDir('cp-mkt-'), rulesFor(process.platform));
  const origin = new DirectoryMarketplace(dir, 'context-plugins-local');
  const f = fake({ 'plugin marketplace list': marketplaces() });

  await codex.install({ ...CTX, origin }, f.opts);

  assert.ok(f.calls.includes(`plugin marketplace add ${dir.toString()}`));
  assert.ok(f.calls.includes('plugin add xero-sdk@context-plugins-local'));
});

// What codex-cli 0.100.0 and 0.60.1 print: `plugin` is read as a prompt, and
// clap refuses the rest. Measured, not guessed.
const NO_PLUGIN_ADD = { code: 2, stderr: "error: unexpected argument 'marketplace' found" };
const NO_PLUGIN_REMOVE = { code: 2, stderr: "error: unrecognized subcommand 'remove'" };

test('a Codex too old for plugins is a skip that says so, not a failed run', async () => {
  const f = fake({
    'plugin marketplace list': NO_PLUGIN_ADD,
    'plugin marketplace add': NO_PLUGIN_ADD,
  });
  const r = recording();

  const res = await codex.install(r.ctx, f.opts);

  assert.equal(outcome(res), 'skipped', 'a skip lets the editors before it be recorded');
  assert.deepEqual(r.kinds(), ['plugins-unsupported']);
  assert.ok(!f.calls.some((c) => c.startsWith('plugin add')));
});

test('a Codex too old for plugins is asked once per run, however many plugins', async () => {
  const f = fake({
    'plugin marketplace list': NO_PLUGIN_ADD,
    'plugin marketplace add': NO_PLUGIN_ADD,
  });
  const ports = portsFor(stubFetch({}));
  const root = new DirectoryPath(tmpDir('cp-work-'), rulesFor(process.platform));
  const session = createSession({
    registry: registryClient(ports),
    fetcher: sourceFetcher(ports, root),
  });

  await codex.install({ ...CTX, session }, f.opts);
  await codex.install({ ...CTX, plugin: 'other-sdk', session }, f.opts);

  assert.equal(f.calls.filter((c) => c.startsWith('plugin marketplace add')).length, 1);
});

test('uninstall from a Codex too old for plugins could not look, so it is a skip', async () => {
  const f = fake({
    'plugin marketplace list': NO_PLUGIN_ADD,
    'plugin list': { code: 2, stderr: "error: unexpected argument 'list' found" },
    'plugin remove': NO_PLUGIN_REMOVE,
  });
  const r = recording();

  assert.equal(await codex.uninstall(r.ctx, f.opts), 'skipped');
  assert.deepEqual(r.kinds(), ['plugins-unsupported']);
});

// The pattern names the words this harness sends; any other refusal is real.
test('a refusal that is not about the plugin command stays a failure', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(),
    'plugin marketplace add': { code: 1, stderr: "error: unexpected argument '--sparse' found" },
  });
  assert.equal((await codex.install(CTX, f.opts)).ok, false);

  const g = fake({ 'plugin remove': { code: 1, stderr: 'error: permission denied' } });
  assert.equal(await codex.uninstall(CTX, g.opts), 'failed');
});

// Claude and Codex each file a marketplace under a name of their own, so each
// has its own registration memo and neither may be handed the other's.
test("the session memo never hands Codex Claude Code's registration", async () => {
  const ports = portsFor(stubFetch({}));
  const root = new DirectoryPath(tmpDir('cp-work-'), rulesFor(process.platform));
  const session = createSession({
    registry: registryClient(ports),
    fetcher: sourceFetcher(ports, root),
  });
  const origin = CTX.origin;
  session.marketplaces.set(
    origin.key(),
    Promise.resolve(ok({ known: 'claude-name', updated: true })),
  );
  const f = fake({ 'plugin marketplace list': marketplaces(gitEntry('codex-name')) });

  await codex.install({ ...CTX, session }, f.opts);
  await codex.install({ ...CTX, plugin: 'other-sdk', session }, f.opts);

  assert.ok(f.calls.includes('plugin add xero-sdk@codex-name'));
  assert.ok(f.calls.includes('plugin add other-sdk@codex-name'));
  assert.equal(
    f.calls.filter((c) => c.startsWith('plugin marketplace upgrade')).length,
    1,
    'two plugins from one marketplace register it once',
  );
});

// `plugin remove` succeeds whether or not the plugin was there, so the harness
// has to look first: that is the only difference between `removed` and `absent`.
test('a cached plugin is removed', async () => {
  const f = fake();
  const dir = cache(f, 'context-plugins', 'xero-sdk');
  f.opts = {
    ...f.opts,
    runner: runnerFor(async (_file, args) => {
      const line = args.join(' ');
      f.calls.push(line);
      if (line.startsWith('plugin remove')) fs.rmSync(dir, { recursive: true, force: true });
      return { code: line.startsWith('plugin marketplace list') ? 1 : 0, stdout: '', stderr: '' };
    }, f.opts.env),
  };
  const r = recording();

  assert.equal(await codex.uninstall(r.ctx, f.opts), 'removed');
  assert.ok(f.calls.includes('plugin remove xero-sdk@context-plugins'));
  assert.deepEqual(r.kinds(), ['plugin-uninstalled', 'reload']);
});

test('a plugin Codex lists but has no cache for is still removed, not absent', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(gitEntry('context-plugins')),
    'plugin list': installed('xero-sdk@context-plugins'),
  });
  assert.equal(await codex.uninstall(CTX, f.opts), 'removed');
});

test('a plugin Codex does not have is absent, so the record can be cleared', async () => {
  const f = fake({
    'plugin marketplace list': marketplaces(gitEntry('context-plugins')),
    'plugin list': installed('xero-sdk@someone-elses'),
  });
  const r = recording();

  assert.equal(await codex.uninstall(r.ctx, f.opts), 'absent');
  assert.deepEqual(r.kinds(), ['plugin-absent']);
});

test('a removal Codex reports as failed is a failure', async () => {
  const f = fake({ 'plugin remove': { code: 1, stderr: 'EPERM: operation not permitted' } });
  const r = recording();

  assert.equal(await codex.uninstall(r.ctx, f.opts), 'failed');
  assert.deepEqual(r.kinds(), ['plugin-uninstall-failed']);
});

test('a removal that says it worked and leaves the cache is a failure', async () => {
  const f = fake();
  cache(f, 'context-plugins', 'xero-sdk');
  const r = recording();

  assert.equal(await codex.uninstall(r.ctx, f.opts), 'failed');
  assert.deepEqual(r.kinds(), ['plugin-left-behind']);
});

test('uninstall targets the name Codex knows the marketplace by', async () => {
  const f = fake({ 'plugin marketplace list': marketplaces(gitEntry('apimatic-plugins')) });
  await codex.uninstall(CTX, f.opts);
  assert.ok(f.calls.includes('plugin remove xero-sdk@apimatic-plugins'));
});

test('with no CLI, or no name to address it by, uninstall is a skip', async () => {
  const env: Env = { PATH: tmpDir('cp-empty-bin-'), PATHEXT: '.CMD' };
  const none = { env, runner: runnerFor(async () => ({ code: 0, stdout: '', stderr: '' }), env) };
  assert.equal(await codex.uninstall(CTX, none), 'skipped');

  const f = fake({ 'plugin marketplace list': marketplaces() });
  const r = recording({ origin: new RepoMarketplace(REPO) });
  assert.equal(await codex.uninstall(r.ctx, f.opts), 'skipped');
  assert.deepEqual(r.kinds(), ['no-marketplace-name']);
  assert.ok(!f.calls.some((c) => c.startsWith('plugin remove')));
});

test('a plugin listing with a row this build cannot read answers nothing', async () => {
  // Without the cache, an unreadable listing must not be read as "installed"
  // either way - it is simply no evidence, and the removal decides.
  const f = fake({
    'plugin marketplace list': marketplaces(gitEntry('context-plugins')),
    'plugin list': json({ installed: [{ pluginId: 'xero-sdk@context-plugins' }, 'junk'] }),
  });
  assert.equal(await codex.uninstall(CTX, f.opts), 'absent');
});

test('the cache is looked for under CODEX_HOME', async () => {
  const f = fake();
  const expected = paths.codexPluginCacheDir('m', 'p', { env: f.opts.env });
  assert.equal(expected.toString(), path.join(f.home, 'plugins', 'cache', 'm', 'p'));
});

// A registration whose directory has gone makes every Codex listing fail, so
// forgetting it cannot depend on a listing - but a listing that does answer can
// still show the name is another directory's.
test('forgetting the generated marketplace', async () => {
  const dir = new DirectoryPath(tmpDir('cp-mkt-'), rulesFor(process.platform));
  const origin = new DirectoryMarketplace(dir, 'context-plugins-local');
  const events: HarnessEvent[] = [];
  const listener = (e: HarnessEvent) => events.push(e);

  const dangling = fake({
    'plugin marketplace list': { code: 1, stderr: 'failed to load marketplace(s)' },
  });
  await codex.forgetMarketplace(origin, listener, dangling.opts);
  assert.ok(dangling.calls.includes('plugin marketplace remove context-plugins-local'));
  assert.deepEqual(
    events.map((e) => e.kind),
    ['marketplace-removed'],
  );

  const ours = fake({
    'plugin marketplace list': marketplaces({
      name: 'context-plugins-local',
      root: dir.toString(),
    }),
  });
  await codex.forgetMarketplace(origin, listener, ours.opts);
  assert.ok(ours.calls.includes('plugin marketplace remove context-plugins-local'));

  const theirs = fake({
    'plugin marketplace list': marketplaces({
      name: 'context-plugins-local',
      root: '/somewhere/else',
    }),
  });
  await codex.forgetMarketplace(origin, listener, theirs.opts);
  assert.ok(!theirs.calls.some((c) => c.startsWith('plugin marketplace remove')));

  const never = fake({ 'plugin marketplace list': marketplaces() });
  await codex.forgetMarketplace(origin, listener, never.opts);
  assert.ok(!never.calls.some((c) => c.startsWith('plugin marketplace remove')));

  const refused = fake({
    'plugin marketplace list': { code: 1 },
    'plugin marketplace remove': { code: 1, stderr: 'not configured or installed' },
  });
  const before = events.length;
  await codex.forgetMarketplace(origin, listener, refused.opts);
  assert.equal(events.length, before, 'nothing removed, nothing said');
});
