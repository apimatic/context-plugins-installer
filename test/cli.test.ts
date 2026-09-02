import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseArgs, parseTargets, helpText, run } from '../src/cli.js';
import { resolveTargets, NAMES } from '../src/harness/index.js';
import { UserError } from '../src/util.js';
import { silenceConsole, tmpDir, cleanupAll } from './helpers.js';

test.after(cleanupAll);

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
    (err) => err instanceof UserError && /claude, cursor, vscode/.test(err.hint ?? ''),
  );
});

test('help text uses the configured bin name', () => {
  const text = helpText('acme-plugins', {
    displayName: 'Acme AI Plugins',
    label: 'Acme AI Plugins Marketplace',
    ref: 'main',
  });
  assert.ok(text.includes('acme-plugins install <plugin>'));
  assert.ok(text.includes('Acme AI Plugins'));
  assert.ok(!text.toLowerCase().includes('apimatic'));
});

test('the default help text uses the default command name', () => {
  const text = helpText('context-plugins', {
    displayName: 'Context Plugins',
    label: 'Context Plugins Marketplace',
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

test('--version answers even when the rc file is unusable', async () => {
  const cwd = tmpDir('cp-cli-');
  fs.writeFileSync(path.join(cwd, '.contextpluginsrc'), '[1, 2]', 'utf8');
  const prev = process.cwd();
  process.chdir(cwd);
  const con = silenceConsole();
  try {
    assert.equal(await run(['--version']), 0);
    assert.equal(await run(['install', 'x']), 2, 'a real command still reports the rc problem');
  } finally {
    con.restore();
    process.chdir(prev);
  }
});

const STATE_MANIFEST = {
  version: 1,
  plugins: [
    { plugin: 'my-sdk', repo: 'context-plugins/plugin-marketplace', targets: ['claude'] },
    // Half readable: listed, but one target belongs to a build that is not this one.
    {
      plugin: 'code-review',
      repo: 'context-plugins/plugin-marketplace',
      targets: ['vscode', 'zed'],
    },
    { plugin: 'future-sdk', repo: 'context-plugins/plugin-marketplace', targets: ['zed'] },
  ],
};

/** run() reads the brand from the ambient cwd, home and CP_* env, so pin all three. */
const AMBIENT = ['CP_STATE_DIR', 'CP_REPO', 'CP_REF', 'CP_MARKETPLACE', 'HOME', 'USERPROFILE'];

const noAnsi = (text: string): string => text.replace(/\x1b\[\d+m/g, '');

/** Runs `installed` against a manifest - and a brand - only this test can see. */
async function installedWith(manifestDoc: unknown, args: string[]) {
  const root = tmpDir('cp-installed-');
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'installed.json'), JSON.stringify(manifestDoc), 'utf8');

  const saved = AMBIENT.map((k) => [k, process.env[k]] as const);
  const prevCwd = process.cwd();
  for (const key of AMBIENT) delete process.env[key];
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere; a developer's
  // own .contextpluginsrc must not decide what this test sees.
  process.env.CP_STATE_DIR = state;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.chdir(root);

  const con = silenceConsole();
  try {
    const code = await run(['installed', ...args]);
    const err = noAnsi(con.err.join(' ')).split(' ').filter(Boolean).join(' ');
    return { code, out: con.out.join('\n'), err };
  } finally {
    con.restore();
    process.chdir(prevCwd);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('installed --json leaves stdout to the payload and puts the warnings on stderr', async () => {
  const { code, out, err } = await installedWith(STATE_MANIFEST, ['--json']);
  assert.equal(code, 0);

  const payload: { plugin: string; targets: string[] }[] = JSON.parse(out);
  assert.deepEqual(
    payload.map((e) => e.plugin),
    ['my-sdk', 'code-review'],
    'stdout parses on its own - no warning line reached it',
  );
  assert.deepEqual(payload[1]?.targets, ['vscode'], 'the row is listed without the zed target');
  assert.ok(
    err.includes("Ignoring 'future-sdk' in installed.json - unknown target(s): zed."),
    `the dropped row is named on stderr, got: ${err}`,
  );
  assert.ok(
    err.includes("Listing 'code-review' without unknown target(s): zed - the entry on disk"),
    `so is the target the listed row lost, got: ${err}`,
  );
});

test('the human listing warns about the same gaps, on stdout', async () => {
  const { out, err } = await installedWith(STATE_MANIFEST, []);
  assert.equal(err, '', 'without --json there is no payload to keep clean');
  assert.ok(out.includes('future-sdk'));
  assert.ok(out.includes("Listing 'code-review' without unknown target(s): zed"));
});

test('--quiet silences the warnings, never the payload --json was run for', async () => {
  const { code, out, err } = await installedWith(STATE_MANIFEST, ['--json', '--quiet']);
  assert.equal(code, 0);
  const payload: { plugin: string }[] = JSON.parse(out);
  assert.deepEqual(
    payload.map((e) => e.plugin),
    ['my-sdk', 'code-review'],
  );
  assert.equal(err, '', 'the warnings are what --quiet is for');
});
