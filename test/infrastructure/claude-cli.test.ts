import test from 'node:test';
import assert from 'node:assert';

import { claudeCli, findClaude } from '../../src/infrastructure/claude-cli.js';
import type { RunCommand, RunResult } from '../../src/types/ports.js';
import { silenceConsole } from '../helpers.js';

/** Records the argv it was given, so the one place `claude` argv is spelled is pinned. */
function recorder(result: Partial<RunResult> = {}): RunCommand & { argv: string[][] } {
  const argv: string[][] = [];
  const exec = async (_file: string, args: string[]): Promise<RunResult> => {
    argv.push(args);
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return Object.assign(exec, { argv });
}

const listing = (body: unknown): Partial<RunResult> => ({ code: 0, stdout: JSON.stringify(body) });

test('findClaude looks for claude on the PATH it is given, not the host one', () => {
  assert.equal(findClaude({ PATH: '', PATHEXT: '' }), null);
});

/**
 * These six argv arrays are the whole conversation this program has with the
 * `claude` binary. A wrong flag or a reordered subcommand is not a crash, it is
 * a command that does something else, so they are asserted literally.
 */
test('every command spells the argv the CLI expects', async () => {
  const exec = recorder();
  const cli = claudeCli('/usr/bin/claude', exec);

  await cli.listMarketplaces();
  await cli.listPlugins();
  await cli.marketplaceAdd('acme/marketplace');
  await cli.marketplaceUpdate('acme');
  await cli.pluginInstall('xero@acme', 'user');
  await cli.pluginUninstall('xero@acme', 'user');

  assert.deepEqual(exec.argv, [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'add', 'acme/marketplace'],
    ['plugin', 'marketplace', 'update', 'acme'],
    ['plugin', 'install', 'xero@acme', '--scope', 'user'],
    ['plugin', 'uninstall', 'xero@acme', '--scope', 'user'],
  ]);
});

test('a listing arrives as a bare array or under its own key', async () => {
  const bare = claudeCli('claude', recorder(listing([{ name: 'acme' }])));
  assert.deepEqual(await bare.listMarketplaces(), [{ name: 'acme' }]);

  const wrapped = claudeCli('claude', recorder(listing({ marketplaces: [{ name: 'acme' }] })));
  assert.deepEqual(await wrapped.listMarketplaces(), [{ name: 'acme' }]);

  const otherKey = claudeCli('claude', recorder(listing({ plugins: [{ name: 'acme' }] })));
  assert.equal(await otherKey.listMarketplaces(), null, 'a payload under some other key');
});

test('a CLI that cannot answer says null, never an empty answer', async () => {
  const failed = claudeCli('claude', recorder({ code: 1, stderr: 'unknown option --json' }));
  assert.equal(await failed.listMarketplaces(), null);
  assert.equal(await failed.listPlugins(), null);

  const garbage = claudeCli('claude', recorder({ code: 0, stdout: 'Usage: claude plugin' }));
  assert.equal(await garbage.listMarketplaces(), null);
  assert.equal(await garbage.listPlugins(), null);
});

// Opposite policies on purpose: one unreadable marketplace must not hide the
// rest, while one unreadable plugin row must not look like "nothing installed".
test('junk marketplace rows are dropped, junk plugin rows make the answer unknown', async () => {
  const markets = claudeCli('claude', recorder(listing([{ name: 'acme' }, 'bare', 42, null])));
  assert.deepEqual(await markets.listMarketplaces(), [{ name: 'acme' }]);

  const plugins = claudeCli('claude', recorder(listing([{ id: 'xero@acme' }, { name: 'no-id' }])));
  assert.equal(await plugins.listPlugins(), null);
});

test('an empty listing is an answer, and an empty one', async () => {
  const cli = claudeCli('claude', recorder(listing([])));
  assert.deepEqual(await cli.listPlugins(), []);
  assert.deepEqual(await cli.listMarketplaces(), []);
});

/**
 * The id is `plugin@marketplace`, and the marketplace half is whatever name
 * Claude filed it under - so only the plugin half can be compared. Splitting at
 * the last `@` leaves a leading-`@` id whole, which is the one spelling where
 * there is no marketplace half to drop.
 */
test('the plugin id is read off the row, and the scope when it says one', async () => {
  const cli = claudeCli(
    'claude',
    recorder(
      listing([
        { id: 'xero@acme', scope: 'user' },
        { id: 'plain-id' },
        { id: '@scoped/name' },
        { id: 'two@ats@acme', scope: 'project' },
      ]),
    ),
  );
  assert.deepEqual(await cli.listPlugins(), [
    { plugin: 'xero', scope: 'user' },
    { plugin: 'plain-id', scope: null },
    { plugin: '@scoped/name', scope: null },
    { plugin: 'two@ats', scope: 'project' },
  ]);
});

// The phase's exit condition for this module.
test('the boundary reports through its return value and prints nothing', async () => {
  const cli = claudeCli('claude', recorder({ code: 1, stderr: 'boom' }));
  const con = silenceConsole();
  try {
    await cli.listPlugins();
    await cli.pluginInstall('xero@acme', 'user');
  } finally {
    con.restore();
  }
  assert.deepEqual(con.lines, [], 'infrastructure printed something');
});
