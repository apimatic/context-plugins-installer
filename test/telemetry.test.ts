import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBrand, type ResolveBrandOptions } from '../src/brand.js';
import * as paths from '../src/paths.js';
import {
  EVENTS,
  createTelemetry,
  describeTelemetry,
  isCi,
  marketplaceLabel,
  setTelemetryEnabled,
  telemetryStatus,
  type TelemetryOptions,
} from '../src/telemetry.js';
import type { Brand, FetchLike, FetchResponseLike, PathOpts } from '../src/types.js';
import { tmpDir, cleanupAll, silenceConsole } from './helpers.js';

test.after(cleanupAll);

const REPO = 'context-plugins/plugin-marketplace';
const TRACK_URL = 'https://api.mixpanel.com/track?ip=0&verbose=1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const brand = (over: ResolveBrandOptions = {}): Brand =>
  resolveBrand({ env: {}, cwd: tmpDir('cp-cwd-'), home: tmpDir('cp-home-'), ...over });

/** A sandboxed state dir, so the id file never lands in the developer's home. */
function machine(): { pathOpts: PathOpts; file: string } {
  const root = tmpDir('cp-telemetry-');
  const pathOpts = { env: { CP_STATE_DIR: path.join(root, 'state') }, home: root };
  return { pathOpts, file: paths.telemetryPath(pathOpts) };
}

interface Sent {
  url: string;
  init: Parameters<FetchLike>[1];
}

interface SentEvent {
  event: string;
  properties: Record<string, unknown>;
}

/** Records every request and answers the way Mixpanel's verbose mode does. */
function sink(status = 200, body = '{"status":1}'): FetchLike & { sent: Sent[] } {
  const sent: Sent[] = [];
  const impl: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const res: FetchResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async (): Promise<unknown> => JSON.parse(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    return res;
  };
  return Object.assign(impl, { sent });
}

const eventsIn = (sent: Sent): SentEvent[] => JSON.parse(sent.init?.body ?? '[]') as SentEvent[];

const readState = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

function telemetryFor(
  m: { pathOpts: PathOpts },
  fetchImpl: FetchLike,
  over: Partial<TelemetryOptions> = {},
) {
  return createTelemetry({
    brand: brand(),
    command: 'install',
    version: '9.9.9',
    deps: { env: {}, fetchImpl },
    pathOpts: m.pathOpts,
    ...over,
  });
}

async function flushQuietly(t: { flush(): Promise<void> }) {
  const con = silenceConsole();
  try {
    await t.flush();
  } finally {
    con.restore();
  }
  return con;
}

test('one flush is one request carrying the token, the anonymous id, and the run-level facts', async () => {
  const m = machine();
  const mixpanel = sink();
  const t = telemetryFor(m, mixpanel);
  t.track(EVENTS.installed, { plugin: 'my-sdk', harness: 'cursor' });
  t.track(EVENTS.installed, { plugin: 'my-sdk', harness: 'vscode' });
  await flushQuietly(t);

  assert.equal(mixpanel.sent.length, 1, 'both events travel in one batch');
  const [req] = mixpanel.sent;
  assert.equal(req?.url, TRACK_URL, 'ip=0 keeps geolocation off, verbose=1 makes errors readable');
  assert.equal(req?.init?.method, 'POST');
  assert.equal(req?.init?.headers?.['Content-Type'], 'application/json');
  assert.ok(req?.init?.signal instanceof AbortSignal, 'the request is bounded');

  const events = eventsIn(req as Sent);
  const id = readState(m.file).id;
  assert.match(String(id), UUID, 'the machine id is a random uuid, not a fingerprint');
  assert.deepEqual(
    events.map((e) => e.properties.harness),
    ['cursor', 'vscode'],
  );
  for (const e of events) {
    assert.equal(e.event, 'Context Plugin Installed');
    assert.equal(e.properties.token, brand().telemetry.token);
    assert.equal(e.properties.$device_id, id);
    assert.equal(e.properties.distinct_id, `$device:${id}`, 'simplified id merge shape');
    assert.equal(e.properties.command, 'install');
    assert.equal(e.properties.cli_version, '9.9.9');
    assert.equal(e.properties.os, process.platform);
    assert.equal(e.properties.arch, process.arch);
    assert.equal(e.properties.node_major, Number(process.versions.node.split('.')[0]));
    assert.equal(e.properties.ci, false, 'the injected env has no CI variable');
    assert.equal(typeof e.properties.time, 'number');
    assert.match(String(e.properties.$insert_id), UUID);
  }
  assert.notEqual(events[0]?.properties.$insert_id, events[1]?.properties.$insert_id);
  assert.equal(events[0]?.properties.run_id, events[1]?.properties.run_id);
});

test('an event cannot rename the token or the identity', async () => {
  const m = machine();
  const mixpanel = sink();
  const t = telemetryFor(m, mixpanel);
  t.track(EVENTS.installed, { token: 'evil', $device_id: 'someone-else', distinct_id: 'x' });
  await flushQuietly(t);
  const [e] = eventsIn(mixpanel.sent[0] as Sent);
  assert.equal(e?.properties.token, brand().telemetry.token);
  assert.equal(e?.properties.$device_id, readState(m.file).id);
});

test('the anonymous id survives across runs', async () => {
  const m = machine();
  const first = sink();
  const t1 = telemetryFor(m, first);
  t1.track(EVENTS.installed, { plugin: 'a' });
  await flushQuietly(t1);
  const second = sink();
  const t2 = telemetryFor(m, second);
  t2.track(EVENTS.installed, { plugin: 'b' });
  await flushQuietly(t2);
  assert.equal(
    eventsIn(second.sent[0] as Sent)[0]?.properties.$device_id,
    eventsIn(first.sent[0] as Sent)[0]?.properties.$device_id,
  );
});

test('nothing tracked means nothing sent, no id minted, and no notice', async () => {
  const m = machine();
  const mixpanel = sink();
  const con = await flushQuietly(telemetryFor(m, mixpanel));
  assert.equal(mixpanel.sent.length, 0);
  assert.equal(fs.existsSync(m.file), false, 'a read-only command leaves no file behind');
  assert.deepEqual(con.lines, []);
});

test('the notice is printed once, on stderr, and then remembered', async () => {
  const m = machine();
  const t1 = telemetryFor(m, sink());
  t1.track(EVENTS.installed, { plugin: 'a' });
  const first = await flushQuietly(t1);
  // Rewrapped: the notice is wrapped to the terminal width, and a phrase may straddle a break.
  const notice = first.err
    .join(' ')
    .replace(/\x1b\[\d+m/g, '')
    .split(/\s+/)
    .join(' ');
  assert.ok(notice.includes('collects anonymous usage data'), `got: ${notice}`);
  assert.ok(notice.includes('context-plugins telemetry disable'), 'says how to opt out');
  assert.ok(notice.includes('DO_NOT_TRACK=1'));
  assert.deepEqual(first.out, [], 'stdout stays clean');
  assert.equal(readState(m.file).noticeShown, true);

  const t2 = telemetryFor(m, sink());
  t2.track(EVENTS.installed, { plugin: 'b' });
  const second = await flushQuietly(t2);
  assert.deepEqual(second.lines, [], 'a second run says nothing');
});

test('every opt-out switch wins on its own, names itself, and sends nothing', async () => {
  const cases: {
    label: string;
    env?: Record<string, string>;
    brand?: () => Brand;
    before?: (m: { pathOpts: PathOpts }) => void;
    optOut: string;
    described: string;
  }[] = [
    {
      label: 'DO_NOT_TRACK',
      env: { DO_NOT_TRACK: '1' },
      optOut: 'DO_NOT_TRACK',
      described: 'disabled (DO_NOT_TRACK)',
    },
    {
      label: 'DO_NOT_TRACK=true',
      env: { DO_NOT_TRACK: 'true' },
      optOut: 'DO_NOT_TRACK',
      described: 'disabled (DO_NOT_TRACK)',
    },
    {
      label: 'CP_TELEMETRY=off',
      env: { CP_TELEMETRY: 'off' },
      optOut: 'CP_TELEMETRY',
      described: 'disabled (CP_TELEMETRY)',
    },
    {
      label: 'CP_TELEMETRY=0',
      env: { CP_TELEMETRY: '0' },
      optOut: 'CP_TELEMETRY',
      described: 'disabled (CP_TELEMETRY)',
    },
    {
      label: 'rc file',
      brand: () => {
        const cwd = tmpDir('cp-cwd-');
        fs.writeFileSync(path.join(cwd, '.contextpluginsrc'), '{ "telemetry": false }');
        return brand({ cwd });
      },
      optOut: 'rc',
      described: 'disabled (.contextpluginsrc)',
    },
    {
      label: 'telemetry disable',
      before: (m) => assert.equal(setTelemetryEnabled(false, m.pathOpts), true),
      optOut: 'user',
      described: 'disabled (context-plugins telemetry disable)',
    },
    {
      label: 'no token',
      brand: () => brand({ profile: { telemetryToken: null } }),
      optOut: 'no-token',
      described: 'not configured',
    },
  ];

  for (const c of cases) {
    const m = machine();
    c.before?.(m);
    const b = c.brand ? c.brand() : brand();
    const env = c.env ?? {};
    const status = telemetryStatus({ brand: b, env, pathOpts: m.pathOpts });
    assert.equal(status.mode, 'off', c.label);
    assert.equal(status.optOut, c.optOut, c.label);
    assert.equal(describeTelemetry(status, 'context-plugins'), c.described, c.label);

    const mixpanel = sink();
    const t = telemetryFor(m, mixpanel, { brand: b, deps: { env, fetchImpl: mixpanel } });
    t.track(EVENTS.installed, { plugin: 'a' });
    const con = await flushQuietly(t);
    assert.equal(mixpanel.sent.length, 0, `${c.label}: nothing sent`);
    assert.deepEqual(con.lines, [], `${c.label}: nothing said`);
  }
});

test('a "no" value on DO_NOT_TRACK or CP_TELEMETRY leaves telemetry on', () => {
  const m = machine();
  for (const env of [{ DO_NOT_TRACK: '0' }, { DO_NOT_TRACK: '' }, { CP_TELEMETRY: 'on' }, {}]) {
    const status = telemetryStatus({ brand: brand(), env, pathOpts: m.pathOpts });
    assert.equal(status.mode, 'on', JSON.stringify(env));
    assert.equal(describeTelemetry(status, 'context-plugins'), 'enabled');
  }
});

test('telemetry enable undoes telemetry disable', () => {
  const m = machine();
  assert.equal(setTelemetryEnabled(false, m.pathOpts), true);
  const id = readState(m.file).id;
  assert.equal(setTelemetryEnabled(true, m.pathOpts), true);
  const status = telemetryStatus({ brand: brand(), env: {}, pathOpts: m.pathOpts });
  assert.equal(status.mode, 'on');
  assert.equal(status.id, id, 'the id is kept across the toggle');
});

test('CP_TELEMETRY=log prints the payload to stderr and sends nothing, whatever else is set', async () => {
  const m = machine();
  const mixpanel = sink();
  const env = { CP_TELEMETRY: 'log', DO_NOT_TRACK: '1' };
  const t = telemetryFor(m, mixpanel, { deps: { env, fetchImpl: mixpanel } });
  assert.equal(t.status.mode, 'log');
  assert.equal(describeTelemetry(t.status, 'context-plugins'), 'log only (CP_TELEMETRY=log)');
  t.track(EVENTS.uninstalled, { plugin: 'my-sdk', harness: 'cursor' });
  const con = await flushQuietly(t);
  assert.equal(mixpanel.sent.length, 0);
  assert.deepEqual(con.out, []);
  const line = con.err.find((l) => l.includes('telemetry (not sent)'));
  assert.ok(line, `expected the payload on stderr, got ${JSON.stringify(con.err)}`);
  assert.ok(line.includes('Context Plugin Uninstalled'));
  assert.ok(!con.err.join(' ').includes('collects anonymous'), 'no notice when nothing is sent');
});

test('a failing, rejected, or hanging request never fails the run', async () => {
  const m = machine();
  for (const fetchImpl of [
    sink(503, 'oops'),
    (async () => {
      throw new Error('ECONNRESET');
    }) as FetchLike,
  ]) {
    const t = telemetryFor(m, fetchImpl);
    t.track(EVENTS.installed, { plugin: 'a' });
    await flushQuietly(t);
  }

  const hanging: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const t = telemetryFor(m, hanging, { timeoutMs: 20 });
  t.track(EVENTS.installed, { plugin: 'a' });
  await Promise.race([
    flushQuietly(t),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('flush hung')), 2000)),
  ]);
});

test('a corrupt state file is replaced rather than honoured', async () => {
  const m = machine();
  fs.mkdirSync(path.dirname(m.file), { recursive: true });
  fs.writeFileSync(m.file, '{ not json');
  const t = telemetryFor(m, sink());
  t.track(EVENTS.installed, { plugin: 'a' });
  await flushQuietly(t);
  assert.match(String(readState(m.file).id), UUID);

  fs.writeFileSync(m.file, JSON.stringify({ enabled: false }), 'utf8'); // no id: not ours
  assert.equal(telemetryStatus({ brand: brand(), env: {}, pathOpts: m.pathOpts }).mode, 'on');
});

test('CI is detected from the usual variables, and "false" is not CI', () => {
  assert.equal(isCi({}), false);
  assert.equal(isCi({ CI: 'true' }), true);
  assert.equal(isCi({ CI: '1' }), true);
  assert.equal(isCi({ CI: 'false' }), false);
  assert.equal(isCi({ GITHUB_ACTIONS: 'true' }), true);
});

test('the marketplace is named only when it is the one this build ships with', () => {
  assert.equal(marketplaceLabel(brand()), REPO);
  assert.equal(marketplaceLabel(brand({ env: { CP_REPO: 'acme/plugin-marketplace' } })), 'custom');
  const acme = brand({ profile: { repo: 'acme/plugin-marketplace' } });
  assert.equal(marketplaceLabel(acme), 'acme/plugin-marketplace', "a brand's own repo is built in");
});
