'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, parseTargets, helpText, run } = require('../src/cli');
const { resolveTargets, NAMES } = require('../src/harness');
const { UserError } = require('../src/util');
const { silenceConsole } = require('./helpers');

test('the plugin id is positional and the command comes first', () => {
  const parsed = parseArgs(['install', 'my-sdk']);
  assert.equal(parsed.command, 'install');
  assert.deepEqual(parsed.args, ['my-sdk']);
});

test('value flags accept both --flag value and --flag=value', () => {
  assert.equal(parseArgs(['install', 'x', '--repo', 'a/b']).flags.repo, 'a/b');
  assert.equal(parseArgs(['install', 'x', '--repo=a/b']).flags.repo, 'a/b');
});

test('kebab-case flags map to camelCase keys', () => {
  assert.equal(parseArgs(['install', 'x', '--marketplace', 'acme']).flags.marketplace, 'acme');
});

test('boolean flags, their negations, and short forms', () => {
  assert.equal(parseArgs(['install', 'x', '--force']).flags.force, true);
  assert.equal(parseArgs(['install', 'x', '--no-force']).flags.force, false);
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.equal(parseArgs(['-v']).flags.version, true);
});

test('a value flag with no value is a usage error', () => {
  assert.throws(() => parseArgs(['install', 'x', '--repo']), UserError);
});

test('an unknown option is rejected rather than ignored', () => {
  assert.throws(() => parseArgs(['install', 'x', '--nope']), UserError);
});

test('-- stops flag parsing', () => {
  const parsed = parseArgs(['install', '--', '--weird-name']);
  assert.deepEqual(parsed.args, ['--weird-name']);
});

test('targets parse into a list', () => {
  assert.deepEqual(parseTargets('cursor, vscode'), ['cursor', 'vscode']);
  assert.equal(parseTargets(undefined), null);
});

test('targets resolve to canonical order, and all/empty means every harness', () => {
  assert.deepEqual(resolveTargets(null), NAMES);
  assert.deepEqual(resolveTargets(['all']), NAMES);
  assert.deepEqual(resolveTargets(['vscode', 'claude']), ['claude', 'vscode']);
});

test('an unknown target names the valid ones', () => {
  assert.throws(
    () => resolveTargets(['emacs']),
    (err) => err instanceof UserError && /claude, cursor, vscode/.test(err.hint),
  );
});

test('help text uses the configured bin name', () => {
  const text = helpText('acme-plugins', {
    displayName: 'Acme AI Plugins',
    repo: 'acme/plugin-marketplace',
    ref: 'main',
  });
  assert.ok(text.includes('acme-plugins install <plugin>'));
  assert.ok(text.includes('Acme AI Plugins'));
  assert.ok(!text.toLowerCase().includes('apimatic'));
});

test('the default help text uses the default command name', () => {
  const text = helpText('context-plugins', {
    displayName: 'Context Plugins',
    repo: 'context-plugins/plugin-marketplace',
    ref: 'main',
  });
  assert.ok(!text.toLowerCase().includes('apimatic'));
});

test('--help exits 0, a bare invocation exits 2', async () => {
  const con = silenceConsole();
  try {
    assert.equal(await run(['--help']), 0);
    assert.equal(await run([]), 2);
  } finally {
    con.restore();
  }
});

test('--version prints just the version', async () => {
  const con = silenceConsole();
  try {
    assert.equal(await run(['--version']), 0);
  } finally {
    con.restore();
  }
  assert.match(con.lines.join('\n').trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown command exits 1 with a hint', async () => {
  const con = silenceConsole();
  try {
    assert.equal(await run(['frobnicate']), 1);
  } finally {
    con.restore();
  }
  assert.match(con.lines.join('\n'), /Unknown command/);
});

test('install with no plugin id explains itself instead of throwing', async () => {
  const con = silenceConsole();
  const saved = process.env.CP_PLUGIN;
  delete process.env.CP_PLUGIN;
  try {
    assert.equal(await run(['install']), 1);
  } finally {
    if (saved !== undefined) process.env.CP_PLUGIN = saved;
    con.restore();
  }
  assert.match(con.lines.join('\n'), /No plugin specified/);
});

test('an invalid option exits 2 (usage), not 1 (runtime)', async () => {
  const con = silenceConsole();
  try {
    assert.equal(await run(['install', 'x', '--bogus']), 2);
  } finally {
    con.restore();
  }
});
