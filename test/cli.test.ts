import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseArgs, parseTargets, helpText, run } from '../src/cli.js';
import { resolveTargets, NAMES } from '../src/harness/index.js';
import { UserError } from '../src/util.js';
import { silenceConsole, tmpDir, cleanupAll, stubFetch } from './helpers.js';
import { rawUrl } from '../src/catalog.js';
import type { FetchLike } from '../src/types.js';

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

/** run() reads the brand from the ambient cwd, home and CP_* env, so pin all of them. */
const AMBIENT = [
  'CP_STATE_DIR',
  'CP_REPO',
  'CP_REF',
  'CP_MARKETPLACE',
  'CP_TELEMETRY',
  'DO_NOT_TRACK',
  'HOME',
  'USERPROFILE',
];

const noAnsi = (text: string): string => text.replace(/\x1b\[\d+m/g, '');

/** Runs one command against a manifest - and a brand - only this test can see. */
async function runWith(
  args: string[],
  manifestDoc: unknown,
  env: Record<string, string> = {},
  root = tmpDir('cp-installed-'),
) {
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
  // run() has no deps seam, so the real Mixpanel endpoint is one env var away:
  // off unless a test pins fetch and says otherwise.
  process.env.CP_TELEMETRY = 'off';
  process.chdir(root);

  Object.assign(process.env, env);

  const con = silenceConsole();
  try {
    const code = await run(args);
    // `out` stays verbatim for JSON.parse; `text` is the same lines rewrapped, so a
    // wrapped warning can be matched as the one sentence it is.
    const flatten = (lines: string[]) =>
      noAnsi(lines.join(' ')).split(' ').filter(Boolean).join(' ');
    return {
      code,
      root,
      out: con.out.join('\n'),
      text: flatten(con.out),
      err: flatten(con.err),
    };
  } finally {
    con.restore();
    process.chdir(prevCwd);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// `installed --targets vscode` used to answer exactly as though the flag were
// absent: accepted, ignored, no signal.
const PER_EDITOR = {
  version: 1,
  plugins: [
    { plugin: 'only-cursor', repo: REPO, marketplace: 'apimatic', targets: ['cursor'] },
    { plugin: 'only-vscode', repo: REPO, marketplace: 'apimatic', targets: ['vscode'] },
    { plugin: 'both', repo: REPO, marketplace: 'apimatic', targets: ['cursor', 'vscode'] },
  ],
};

test('installed --targets lists only what is recorded for those editors', async () => {
  const { code, text } = await runWith(['installed', '--targets', 'vscode'], PER_EDITOR);

  assert.equal(code, 0);
  assert.ok(text.includes('only-vscode'));
  assert.ok(text.includes('both'), 'a plugin in several editors still counts');
  assert.ok(!text.includes('only-cursor'), 'and one in none of them does not');
  assert.ok(text.includes('2 plugins installed in VS Code'), 'the heading says what it filtered');
});

test('installed --targets filters the --json payload the same way', async () => {
  const { out } = await runWith(['installed', '--targets', 'cursor', '--json'], PER_EDITOR);
  const payload: { plugin: string }[] = JSON.parse(out);

  assert.deepEqual(
    payload.map((e) => e.plugin).sort(),
    ['both', 'only-cursor'],
    'the payload is the filtered rows, in the same shape as before',
  );
});

test('installed --targets still shows every editor a listed plugin is recorded for', async () => {
  const { text } = await runWith(['installed', '--targets', 'vscode'], PER_EDITOR);
  // The filter chooses the rows; it does not narrow what each row says.
  assert.ok(text.includes('both Cursor, VS Code'), text);
});

test('installed --targets with no match says so, rather than "none yet"', async () => {
  const { text } = await runWith(['installed', '--targets', 'claude'], PER_EDITOR);
  assert.ok(text.includes('No plugins installed in Claude Code.'), text);
});

test('installed --targets all is the same as not asking', async () => {
  const every = await runWith(['installed', '--targets', 'all'], PER_EDITOR);
  const plain = await runWith(['installed'], PER_EDITOR);
  assert.equal(every.text, plain.text);
});

test('an unknown --targets value is refused, not quietly dropped', async () => {
  const { code, err } = await runWith(['installed', '--targets', 'emacs'], PER_EDITOR);
  assert.equal(code, 1);
  assert.ok(err.includes('Unknown target(s): emacs'), err);
});

// The defect class behind the report: a flag that does nothing must not answer
// as though it were absent.
test('--targets on a command that ignores it warns on stderr', async () => {
  const { code, err } = await runWith(['doctor', '--targets', 'vscode'], PER_EDITOR);
  assert.ok(err.includes('--targets does nothing for `doctor`'), err);
  assert.ok(code === 0 || code === 1, 'the warning does not change the outcome');
});

test('installed --json leaves stdout to the payload and puts the warnings on stderr', async () => {
  const { code, out, err } = await runWith(['installed', '--json'], STATE_MANIFEST);
  assert.equal(code, 0);

  const payload: { plugin: string; targets: string[] }[] = JSON.parse(out);
  assert.deepEqual(
    payload.map((e) => e.plugin),
    ['my-sdk', 'code-review'],
    'stdout parses on its own - no warning line reached it',
  );
  assert.deepEqual(payload[1]?.targets, ['vscode'], 'the row is listed without the zed target');
  assert.ok(
    err.includes(`Ignoring 'future-sdk' (${REPO}) in installed.json - unknown target(s): zed.`),
    `the dropped row is named on stderr, got: ${err}`,
  );
  assert.ok(
    err.includes(
      `Listing 'code-review' (${REPO}) without unknown target(s): zed - the entry on disk`,
    ),
    `so is the target the listed row lost, got: ${err}`,
  );
});

test('the human listing warns about the same gaps, on stdout', async () => {
  const { text, err } = await runWith(['installed'], STATE_MANIFEST);
  assert.equal(err, '', 'without --json there is no payload to keep clean');
  assert.ok(text.includes(`Ignoring 'future-sdk' (${REPO}) in installed.json`));
  assert.ok(text.includes(`Listing 'code-review' (${REPO}) without unknown target(s): zed`));
});

test('--quiet silences the warnings, never the payload --json was run for', async () => {
  const { code, out, err } = await runWith(['installed', '--json', '--quiet'], STATE_MANIFEST);
  assert.equal(code, 0);
  const payload: { plugin: string }[] = JSON.parse(out);
  assert.deepEqual(
    payload.map((e) => e.plugin),
    ['my-sdk', 'code-review'],
  );
  assert.equal(err, '', 'the warnings are what --quiet is for');
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
    return await runWith(args, manifestDoc, { CP_REPO: REPO });
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

test('telemetry disable and enable round-trip through the state file, and status names the switch in effect', async () => {
  const root = tmpDir('cp-telemetry-cli-');
  const env = { CP_TELEMETRY: 'on' };

  const off = await runWith(['telemetry', 'disable'], NO_PLUGINS, env, root);
  assert.equal(off.code, 0);
  assert.ok(off.text.includes('Telemetry disabled.'), off.text);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'telemetry.json'), 'utf8'));
  assert.equal(state.enabled, false);

  const status = await runWith(['telemetry', 'status'], NO_PLUGINS, env, root);
  assert.ok(
    status.text.includes('Telemetry is disabled (context-plugins telemetry disable).'),
    status.text,
  );
  assert.ok(status.text.includes(`Anonymous machine id: ${state.id}`));

  const on = await runWith(['telemetry', 'enable'], NO_PLUGINS, env, root);
  assert.ok(on.text.includes('Telemetry enabled.'), on.text);
  const after = await runWith(['telemetry'], NO_PLUGINS, env, root);
  assert.ok(after.text.includes('Telemetry is enabled.'), after.text);

  const dnt = await runWith(
    ['telemetry', 'enable'],
    NO_PLUGINS,
    { ...env, DO_NOT_TRACK: '1' },
    root,
  );
  assert.ok(
    dnt.text.includes('disabled (DO_NOT_TRACK)'),
    `a broader switch is named when it overrides the saved choice, got: ${dnt.text}`,
  );

  const bad = await runWith(['telemetry', 'frobnicate'], NO_PLUGINS, env, root);
  assert.equal(bad.code, 1);
  assert.ok(bad.err.includes('Unknown telemetry action: frobnicate'), bad.err);
});

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
    const { code, out, err } = await runWith(['install', 'my-sdk'], NO_PLUGINS, {
      CP_TELEMETRY: 'on',
    });
    assert.equal(code, 1);
    assert.equal(requests.length, 1, 'one request for the run');
    assert.equal(requests[0]?.url, 'https://api.mixpanel.com/track?ip=0&verbose=1');
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
    const { code, err } = await runWith(['install', 'my-sdk'], NO_PLUGINS, { CP_TELEMETRY: 'off' });
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
    const { code } = await runWith(['remove', 'Not_Valid'], NO_PLUGINS, { CP_TELEMETRY: 'on' });
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

test('telemetry disable under CP_TELEMETRY=log says the log mode still wins', async () => {
  const { code, text } = await runWith(['telemetry', 'disable'], NO_PLUGINS, {
    CP_TELEMETRY: 'log',
  });
  assert.equal(code, 0);
  assert.ok(text.includes('Telemetry disabled.'), text);
  assert.ok(text.includes('Right now it is log only (CP_TELEMETRY=log)'), text);
});

test('the read-only commands never touch telemetry.json', async () => {
  const { code, root } = await runWith(['installed'], NO_PLUGINS, { CP_TELEMETRY: 'on' });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(root, 'state', 'telemetry.json')), false);
});
