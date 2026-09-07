import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseArgs, parseTargets, helpText, run } from '../src/cli.js';
import { UserError } from '../src/util.js';
import { runCli } from './cli-harness.js';
import { silenceConsole, tmpDir, cleanupAll, stubFetch } from './helpers.js';
import { rawUrl } from '../src/infrastructure/github-registry-client.js';
import type { FetchLike } from '../src/types/ports.js';

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

/** `list` fetches the registry and run() has no deps seam, so pin the global fetch. */
async function listWith(args: string[], manifestDoc: unknown) {
  const saved = globalThis.fetch;
  globalThis.fetch = stubFetch({
    [rawUrl(REPO, 'main', '.claude-plugin/marketplace.json')]: {
      body: {
        name: 'context-plugins',
        plugins: [
          { name: 'code-review', source: './plugins/code-review' },
          { name: 'future-sdk', source: './plugins/future-sdk' },
        ],
      },
    },
  }) as unknown as typeof globalThis.fetch;
  try {
    return await runCli(args, manifestDoc, { CP_REPO: REPO });
  } finally {
    globalThis.fetch = saved;
  }
}

test('list --json warns about the rows behind its installed marks, scoped to the marketplace', async () => {
  const { code, out, err } = await listWith(['list', '--json'], STATE_MANIFEST);
  assert.equal(code, 0);

  const payload: { plugins: { name: string; targets: string[]; installed: boolean }[] } =
    JSON.parse(out);
  const codeReview = payload.plugins.find((p) => p.name === 'code-review');
  assert.deepEqual(codeReview?.targets, ['vscode'], 'the row is listed without the zed target');
  assert.equal(
    payload.plugins.find((p) => p.name === 'future-sdk')?.installed,
    false,
    'and a row it cannot read at all reads as not installed - which is why it warns',
  );

  assert.ok(err.includes("Ignoring 'future-sdk' in installed.json - unknown target(s): zed."));
  assert.ok(err.includes("Listing 'code-review' without unknown target(s): zed"));
  assert.ok(!err.includes(REPO), 'the repo is implied by the listing, so it is left out');
  assert.ok(!err.includes('other-sdk'), 'another marketplace is not this listing to explain');
});

test('the human list puts those warnings on stdout with the listing', async () => {
  const { text, err } = await listWith(['list'], STATE_MANIFEST);
  assert.equal(err, '');
  assert.ok(text.includes("Listing 'code-review' without unknown target(s): zed"));
  assert.ok(!text.includes('other-sdk'));
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
