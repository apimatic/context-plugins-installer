import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ListAction } from '../../src/actions/list.js';

import { rawUrl, registryClient } from '../../src/infrastructure/github-registry-client.js';
import { upsert } from '../../src/infrastructure/manifest-store.js';
import * as paths from '../../src/infrastructure/paths.js';
import type { HarnessName } from '../../src/types/harness.js';
import { announceMarketplace } from '../../src/prompts/marketplace.js';
import { cleanupAll, portsFor, resolveBrand, stubFetch, tmpDir } from '../helpers.js';

test.after(cleanupAll);

// The action over a stubbed registry and a real state directory: what the
// listing says, and where the installed marks come from. How it is rendered
// belongs to test/commands/list.test.ts.

const REPO = 'context-plugins/plugin-marketplace';

const brand = () =>
  resolveBrand({ env: { CP_REPO: REPO }, cwd: tmpDir('cp-cwd-'), home: tmpDir('cp-home-') });

/** A machine with a state directory only this test can see. */
function machine() {
  const root = tmpDir('cp-list-');
  const env = { CP_STATE_DIR: path.join(root, 'state') };
  fs.mkdirSync(env.CP_STATE_DIR, { recursive: true });
  return { root, pathOpts: { env, home: root } };
}

const registry = (plugins: unknown[], name = 'context-plugins', repo = REPO) =>
  stubFetch({
    [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: { body: { name, plugins } },
  });

const record = (
  m: ReturnType<typeof machine>,
  plugin: string,
  targets: HarnessName[],
  repo = REPO,
) =>
  upsert(paths.manifestPath(m.pathOpts), {
    plugin,
    repo,
    ref: 'main',
    marketplace: 'context-plugins',
    targets,
    installedAt: '2026-01-01T00:00:00.000Z',
  });

const listing = async (m: ReturnType<typeof machine>, fetchImpl: ReturnType<typeof registry>) =>
  new ListAction(registryClient(portsFor(fetchImpl)), announceMarketplace, m.pathOpts).execute(
    brand(),
  );

test('the marketplace name and every plugin it offers come from the registry', async () => {
  const m = machine();

  const result = await listing(m, registry([{ name: 'alpha' }, { name: 'beta' }]));

  assert.equal(result.isSuccess(), true);
  assert.equal(result.report.result.marketplace, 'context-plugins');
  assert.deepEqual(
    result.report.result.plugins.map((p) => p.name),
    ['alpha', 'beta'],
  );
});

test('a description is carried through, and a missing one is empty rather than absent', async () => {
  const m = machine();

  const result = await listing(
    m,
    registry([{ name: 'alpha', description: 'does things' }, { name: 'beta' }]),
  );

  assert.equal(result.report.result.plugins[0]?.description, 'does things');
  assert.equal(result.report.result.plugins[1]?.description, '');
});

test('a plugin recorded for this marketplace is marked installed, with its editors', async () => {
  const m = machine();
  record(m, 'alpha', ['cursor']);

  const result = await listing(m, registry([{ name: 'alpha' }, { name: 'beta' }]));

  const [alpha, beta] = result.report.result.plugins;
  assert.equal(alpha?.installed, true);
  assert.deepEqual(alpha?.targets, ['cursor'], 'the editors it actually went into');
  assert.equal(beta?.installed, false);
  assert.deepEqual(beta?.targets, []);
});

/**
 * The same plugin id can exist in two marketplaces, so a mark has to come from
 * a row for *this* repo - otherwise listing one marketplace would show a plugin
 * as installed because a same-named one from somewhere else is.
 */
test('a row from another marketplace never marks this listing', async () => {
  const m = machine();
  record(m, 'alpha', ['cursor'], 'acme/other-marketplace');

  const result = await listing(m, registry([{ name: 'alpha' }]));

  assert.equal(result.report.result.plugins[0]?.installed, false);
});

// GitHub reads an owner and a repository name case-insensitively, and so must
// the mark: two spellings are one marketplace.
test('a row spelled in another case still marks the listing', async () => {
  const m = machine();
  record(m, 'alpha', ['cursor'], 'Context-Plugins/Plugin-Marketplace');

  const result = await listing(m, registry([{ name: 'alpha' }]));

  assert.equal(result.report.result.plugins[0]?.installed, true);
});

/**
 * `RepoSlug.same` means one repo can match more than one row: a manifest an
 * older build wrote can hold both spellings, which is the state fix 01e578d
 * describes a `--force` run producing. `foldRows` is this program's answer to
 * that everywhere else - a later row wins a field both set, and target lists
 * are unioned - so the marks have to fold too, or `list` says a plugin is in
 * one editor while `uninstall` removes it from two.
 */
test('two spellings of one repo are one row, and their editors are unioned', async () => {
  const m = machine();
  const file = paths.manifestPath(m.pathOpts).toString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = (repo: string, targets: HarnessName[]) => ({
    plugin: 'alpha',
    repo,
    ref: 'main',
    marketplace: 'context-plugins',
    targets,
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      plugins: [row('Context-Plugins/Plugin-Marketplace', ['claude']), row(REPO, ['cursor'])],
    }),
  );

  const result = await listing(m, registry([{ name: 'alpha' }]));

  assert.equal(result.report.result.plugins[0]?.installed, true);
  assert.deepEqual(
    result.report.result.plugins[0]?.targets,
    ['claude', 'cursor'],
    'both rows count - the last one does not simply win',
  );
});

test('the gaps in the read view travel with the listing', async () => {
  const m = machine();
  record(m, 'alpha', ['cursor']);
  upsert(paths.manifestPath(m.pathOpts), {
    plugin: 'future',
    repo: REPO,
    ref: 'main',
    marketplace: 'context-plugins',
    targets: ['cursor', 'zed'],
  });

  const result = await listing(m, registry([{ name: 'alpha' }, { name: 'future' }]));

  assert.deepEqual(
    result.report.gaps.elided.map((e) => e.plugin),
    ['future'],
    'so the caller can say which target it left out',
  );
});

test('a registry with no marketplace file is a failure, not an empty listing', async () => {
  const m = machine();

  const result = await new ListAction(
    registryClient(portsFor(stubFetch({}))),
    announceMarketplace,
    m.pathOpts,
  ).execute(brand());

  assert.equal(result.isFailed(), true);
  assert.equal(result.exitCode(), 1);
  assert.match(result.failure?.message ?? '', /Could not read/);
  assert.match(result.failure?.hint ?? '', /--repo/);
  assert.deepEqual(result.report.result.plugins, [], 'and nothing is claimed about it');
});
