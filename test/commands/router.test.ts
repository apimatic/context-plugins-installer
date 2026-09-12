import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseArgs, parseTargets } from '../../src/commands/args.js';
import { helpText } from '../../src/commands/help.js';
import { services } from '../../src/composition/index.js';
import { openManifest } from '../../src/infrastructure/manifest-store.js';
import { createSession } from '../../src/infrastructure/session.js';
import { run } from '../../src/main.js';
import { runCli, runRouter } from '../cli-harness.js';
import { type Wiring, pluginSource, registryOnly, wiring } from '../install-fixture.js';
import { cleanupAll, orThrow, silenceConsole, stubFetch, tmpDir } from '../helpers.js';
import { rawUrl } from '../../src/infrastructure/github-registry-client.js';
import type { FetchLike } from '../../src/types/ports.js';
import type { Services } from '../../src/types/services.js';

// The router, through the real entry point: which exit code a command line
// answers with, and which of them never reaches a command at all. `orThrow`
// unwraps the parser's `Result` where a test only cares about the parse.

const parse = (argv: string[]) => orThrow(parseArgs(argv));

test.after(cleanupAll);

test('the plugin id is positional and the command comes first', () => {
  const parsed = parse(['install', 'my-sdk']);
  assert.equal(parsed.command, 'install');
  assert.deepEqual(parsed.args, ['my-sdk']);
});

test('value flags accept both --flag value and --flag=value', () => {
  assert.equal(parse(['install', 'x', '--repo', 'a/b']).flags.repo, 'a/b');
  assert.equal(parse(['install', 'x', '--repo=a/b']).flags.repo, 'a/b');
});

test('kebab-case flags map to camelCase keys', () => {
  assert.equal(parse(['install', 'x', '--marketplace', 'acme']).flags.marketplace, 'acme');
});

test('boolean flags, their negations, and short forms', () => {
  assert.equal(parse(['install', 'x', '--force']).flags.force, true);
  assert.equal(parse(['install', 'x', '--no-force']).flags.force, false);
  assert.equal(parse(['-h']).flags.help, true);
  assert.equal(parse(['-v']).flags.version, true);
});

// A `Failure`, not a throw: a command line this parser cannot read is the one
// thing that exits 2, and the router reads that off the answer's shape.
test('a value flag with no value is a usage error', () => {
  const parsed = parseArgs(['install', 'x', '--repo']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error.message, /--repo needs a value/);
});

test('an unknown option is rejected rather than ignored', () => {
  const parsed = parseArgs(['install', 'x', '--nope']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error.message, /Unknown option: --nope/);
});

test('-- stops flag parsing', () => {
  const parsed = parse(['install', '--', '--weird-name']);
  assert.deepEqual(parsed.args, ['--weird-name']);
});

test('targets parse into a list', () => {
  assert.deepEqual(parseTargets('cursor, vscode'), ['cursor', 'vscode']);
  assert.equal(parseTargets(undefined), null);
});

test('help text uses the configured bin name', () => {
  const text = helpText('acme-plugins', {
    displayName: 'Acme AI Plugins',
    label: 'Acme AI Plugins Marketplace',
    ref: 'main',
  });
  assert.ok(text.includes('acme-plugins install <plugin|path|repo>'));
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

const REPO = 'context-plugins/plugin-marketplace';

const STATE_MANIFEST = {
  version: 1,
  plugins: [
    { plugin: 'my-sdk', repo: REPO, targets: ['claude'] },
    // Half readable: listed, but one target belongs to a build that is not this one.
    { plugin: 'code-review', repo: REPO, targets: ['vscode', 'zed'] },
    { plugin: 'future-sdk', repo: REPO, targets: ['zed'] },
    // Another marketplace entirely: `list` must not warn about it.
    { plugin: 'other-sdk', repo: 'acme/marketplace', targets: ['zed'] },
  ],
};

// The defect class behind the report: a flag that does nothing must not answer
// as though it were absent.
test('--targets on a command that ignores it warns on stderr', async () => {
  const { code, err } = await runCli(['doctor', '--targets', 'vscode'], STATE_MANIFEST);
  assert.ok(err.includes('--targets does nothing for `doctor`'), err);
  assert.ok(code === 0 || code === 1, 'the warning does not change the outcome');
});

const NO_PLUGINS = { version: 1, plugins: [] };

test('a failed install still leaves one event, with the command and no message, and the notice on stderr', async () => {
  const saved = globalThis.fetch;
  const requests: { url: string; body: string }[] = [];
  const registry = stubFetch({
    [rawUrl(REPO, 'main', '.claude-plugin/marketplace.json')]: {
      body: { name: 'context-plugins', plugins: [{ name: 'other', source: './plugins/other' }] },
    },
  });
  const pinned: FetchLike = async (url, init) => {
    if (!url.startsWith('https://api.mixpanel.com/')) return registry(url, init);
    requests.push({ url, body: init?.body ?? '' });
    return {
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
      json: async () => ({ status: 1 }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  globalThis.fetch = pinned as unknown as typeof fetch;
  try {
    const { code, out, err } = await runCli(['install', 'my-sdk'], NO_PLUGINS, {
      CP_TELEMETRY: 'on',
    });
    assert.equal(code, 1);
    assert.equal(requests.length, 1, 'one request for the run');
    assert.equal(requests[0]?.url, 'https://api.mixpanel.com/track?ip=1&verbose=1');
    const events: { event: string; properties: Record<string, unknown> }[] = JSON.parse(
      requests[0]?.body ?? '[]',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'Context Plugin Install Failed');
    assert.equal(events[0]?.properties.command, 'install');
    assert.equal(events[0]?.properties.plugin, 'my-sdk');
    assert.equal(events[0]?.properties.stage, 'resolve');
    assert.equal(events[0]?.properties.error_kind, 'user');
    assert.ok(!JSON.stringify(events).includes('not listed'), 'the error message stays home');
    assert.ok(err.includes('collects anonymous usage data'), `notice on stderr, got: ${err}`);
    assert.ok(!out.includes('collects anonymous usage data'), 'and not on stdout');
  } finally {
    globalThis.fetch = saved;
  }
});

test('with CP_TELEMETRY=off the same failure sends nothing and says nothing about telemetry', async () => {
  const saved = globalThis.fetch;
  let hits = 0;
  const registry = stubFetch({});
  const pinned: FetchLike = async (url, init) => {
    if (url.startsWith('https://api.mixpanel.com/')) hits += 1;
    return registry(url, init);
  };
  globalThis.fetch = pinned as unknown as typeof fetch;
  try {
    const { code, err } = await runCli(['install', 'my-sdk'], NO_PLUGINS, { CP_TELEMETRY: 'off' });
    assert.equal(code, 1);
    assert.equal(hits, 0);
    assert.ok(!err.includes('anonymous usage data'));
  } finally {
    globalThis.fetch = saved;
  }
});

test('remove is reported as uninstall, and an id that failed validation is not echoed back', async () => {
  const saved = globalThis.fetch;
  const bodies: string[] = [];
  const pinned: FetchLike = async (url, init) => {
    if (url.startsWith('https://api.mixpanel.com/')) bodies.push(init?.body ?? '');
    return {
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
      json: async () => ({ status: 1 }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  globalThis.fetch = pinned as unknown as typeof fetch;
  try {
    const { code } = await runCli(['remove', 'Not_Valid'], NO_PLUGINS, { CP_TELEMETRY: 'on' });
    assert.equal(code, 1);
    const events: { event: string; properties: Record<string, unknown> }[] = JSON.parse(
      bodies[0] ?? '[]',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'Context Plugin Uninstall Failed');
    assert.equal(events[0]?.properties.command, 'uninstall');
    assert.equal(events[0]?.properties.plugin, null);
    assert.equal(events[0]?.properties.error_kind, 'user');
  } finally {
    globalThis.fetch = saved;
  }
});

// ---- the flags the router forwards --------------------------------------
//
// Everything above enters at `run()` and so builds the real services, which
// reach the network and whatever `claude` sits on PATH - which is why no test
// used to drive a *successful* install, uninstall or update through the entry
// point at all. The three commands were always entered at the command instead,
// past the request literal the router builds, so `--targets`, `--force` and
// `--yes` could be replaced with constants there and the whole suite stayed
// green. These drive the real router over a stubbed marketplace instead.

/** The real composition root with only the two network services swapped out. */
const routerServices = (w: Wiring): Services => ({
  ...services(),
  registry: () => w.registry,
  session: (notify) => createSession({ registry: w.registry, fetcher: w.fetcher, notify }),
});

/**
 * Two editors present and no `claude`. The empty PATH is what keeps a real
 * `claude` binary on the developer's machine out of the run, and `inSandbox`
 * restores it afterwards.
 */
function editors(root: string): Record<string, string> {
  const cursor = path.join(root, '.cursor');
  const code = path.join(root, 'code-user');
  fs.mkdirSync(cursor, { recursive: true });
  fs.mkdirSync(code, { recursive: true });
  return { CP_CURSOR_DIR: cursor, CP_VSCODE_USER_DIR: code, PATH: '', PATHEXT: '' };
}

const installedInto = (env: Record<string, string>) => ({
  cursor: fs.existsSync(path.join(env.CP_CURSOR_DIR as string, 'plugins', 'local', 'my-sdk')),
  vscode: fs.existsSync(
    path.join(path.dirname(env.CP_CURSOR_DIR as string), 'state', 'vscode', 'my-sdk'),
  ),
});

test('the router forwards --targets, and it narrows the run', async () => {
  const root = tmpDir('cp-cli-');
  const env = editors(root);
  const w = wiring({ repo: REPO, srcDir: pluginSource() });

  const { code } = await runRouter(
    ['install', 'my-sdk', '--targets', 'cursor'],
    routerServices(w),
    NO_PLUGINS,
    env,
    root,
  );

  assert.equal(code, 0);
  const into = installedInto(env);
  assert.ok(into.cursor, 'Cursor was asked for and got the plugin');
  assert.ok(!into.vscode, '--targets reached the action: VS Code was left out');
  assert.deepEqual(openManifest(path.join(root, 'state', 'installed.json')).list()[0]?.targets, [
    'cursor',
  ]);
});

test('the router forwards --yes, and it takes every editor without asking', async () => {
  const root = tmpDir('cp-cli-');
  const env = editors(root);
  const w = wiring({ repo: REPO, srcDir: pluginSource() });

  const { code, text } = await runRouter(
    ['install', 'my-sdk', '--yes'],
    routerServices(w),
    NO_PLUGINS,
    env,
    root,
  );

  assert.equal(code, 0);
  const into = installedInto(env);
  assert.ok(into.cursor && into.vscode, 'both detected editors were taken');
  assert.ok(
    !text.includes('Non-interactive shell'),
    '--yes reached the action, so it never fell back to "nobody to ask"',
  );
});

/**
 * The control for the two above, and the reason they are not vacuous: with
 * neither flag the same run reports that it had nobody to ask. If `--yes` ever
 * stops being forwarded, that line comes back and the test above fails.
 */
test('with neither flag the same install says it had nobody to ask', async () => {
  const root = tmpDir('cp-cli-');
  const env = editors(root);
  const w = wiring({ repo: REPO, srcDir: pluginSource() });

  const { code, text } = await runRouter(
    ['install', 'my-sdk'],
    routerServices(w),
    NO_PLUGINS,
    env,
    root,
  );

  assert.equal(code, 0);
  const into = installedInto(env);
  assert.ok(into.cursor && into.vscode, 'nobody to ask means take everything detected');
  assert.ok(text.includes('Non-interactive shell'), text);
});

test('the router forwards install --force, which is what overrides a marketplace clash', async () => {
  const clash = {
    version: 1,
    plugins: [
      { plugin: 'my-sdk', repo: 'acme/marketplace', marketplace: 'acme', targets: ['cursor'] },
    ],
  };
  const w = () => wiring({ repo: REPO, srcDir: pluginSource() });

  // The same plugin id, recorded from another marketplace: refused, with a hint
  // naming the flag that gets past it.
  const blocked = tmpDir('cp-cli-');
  const first = await runRouter(
    ['install', 'my-sdk', '--targets', 'cursor'],
    routerServices(w()),
    clash,
    editors(blocked),
    blocked,
  );
  assert.equal(first.code, 1);
  // The sentence goes to stderr and the hint to stdout, so a `--json` payload
  // stays parseable; this is about the flag, so read both.
  assert.match(first.err, /already installed from a different source/);
  assert.match(first.text, /re-run with --force/);

  // And with the flag, it replaces it - so `--force` reached the action.
  const forced = tmpDir('cp-cli-');
  const second = await runRouter(
    ['install', 'my-sdk', '--targets', 'cursor', '--force'],
    routerServices(w()),
    clash,
    editors(forced),
    forced,
  );
  assert.equal(second.code, 0, second.text);
  assert.ok(
    fs.existsSync(path.join(forced, '.cursor', 'plugins', 'local', 'my-sdk')),
    '--force reached the action',
  );
});

test('the router forwards --targets to uninstall, so the other editor keeps its row', async () => {
  const doc = {
    version: 1,
    plugins: [
      {
        plugin: 'my-sdk',
        repo: REPO,
        marketplace: 'context-plugins',
        targets: ['cursor', 'vscode'],
      },
    ],
  };
  const w = registryOnly(stubFetch({}));
  const rowsIn = (root: string) =>
    JSON.parse(fs.readFileSync(path.join(root, 'state', 'installed.json'), 'utf8')).plugins;

  // Named one editor, so the record keeps the other - an `absent` answer clears
  // a target too, which is why this is about which editors were asked at all.
  // Both editors have to be *detectable*, or Cursor answers `skipped` - "could
  // not look" - which keeps the target on the record for a different reason.
  const one = tmpDir('cp-cli-');
  await runRouter(
    ['uninstall', 'my-sdk', '--targets', 'cursor'],
    routerServices(w),
    doc,
    editors(one),
    one,
  );
  assert.equal(rowsIn(one).length, 1, 'the row survives: VS Code was never asked');
  assert.deepEqual(rowsIn(one)[0].targets, ['vscode'], '--targets reached the action');

  // Named none, so every editor is asked and nothing is left to record. This is
  // the control: without it, a `--targets` that stopped being forwarded would
  // look the same as one that was.
  const all = tmpDir('cp-cli-');
  await runRouter(['uninstall', 'my-sdk'], routerServices(w), doc, editors(all), all);
  assert.deepEqual(rowsIn(all), [], 'no --targets means every editor, so the row goes');
});

test('the router forwards --force, which is the only thing that drops a foreign row', async () => {
  const root = tmpDir('cp-cli-');
  const row = { plugin: 'zed-sdk', repo: REPO, marketplace: 'context-plugins', targets: ['zed'] };
  const doc = { version: 1, plugins: [row] };
  const file = path.join(root, 'state', 'installed.json');
  const w = registryOnly(stubFetch({}));

  // Without it, a target list this build cannot read is never inferred away.
  await runRouter(['uninstall', 'zed-sdk'], routerServices(w), doc, { PATH: '' }, root);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).plugins,
    [row],
    "another tool's list is not dropped on an inference",
  );

  // With it, the row goes - so the flag reached the action.
  const root2 = tmpDir('cp-cli-');
  await runRouter(['uninstall', 'zed-sdk', '--force'], routerServices(w), doc, { PATH: '' }, root2);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root2, 'state', 'installed.json'), 'utf8')).plugins,
    [],
    '--force reached the action',
  );
});
