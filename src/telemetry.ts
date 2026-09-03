import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { log } from './log.js';
import * as paths from './paths.js';
import { isInteractive } from './prompt.js';
import type {
  Brand,
  Deps,
  Env,
  FetchLike,
  PathOpts,
  TelemetryEvent,
  TelemetryOptOut,
  TelemetryStatus,
  TelemetryValue,
  TrackFn,
} from './types.js';
import { ensureDir, errorMessage, isPlainObject, nonEmptyString, stripBom } from './util.js';

// Title case with a product prefix, the convention of the Mixpanel project
// these land in.
export const EVENTS = Object.freeze({
  installed: 'Context Plugin Installed',
  installFailed: 'Context Plugin Install Failed',
  uninstalled: 'Context Plugin Uninstalled',
  uninstallFailed: 'Context Plugin Uninstall Failed',
});

/** The request is a courtesy to the run, so it never gets to hold the exit. */
export const FLUSH_TIMEOUT_MS = 1500;

const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);

const CI_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'TF_BUILD',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
];

interface TelemetryState {
  id: string;
  enabled?: boolean;
  noticeShown?: boolean;
}

/** Set to anything but an explicit "no"; `DO_NOT_TRACK=1` and `=true` both count. */
const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && !OFF_VALUES.has(value.toLowerCase());

export const isCi = (env: Env): boolean => CI_VARS.some((name) => isSet(env[name]));

// A corrupt file is replaced, not honoured: it holds an id and two flags this
// CLI wrote itself, so unlike the rc file there is no user intent to protect.
function readState(file: string): TelemetryState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !nonEmptyString(parsed.id)) return null;
  const state: TelemetryState = { id: parsed.id };
  if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled;
  if (typeof parsed.noticeShown === 'boolean') state.noticeShown = parsed.noticeShown;
  return state;
}

function writeState(file: string, state: TelemetryState): boolean {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function optOutOf(brand: Brand, env: Env, state: TelemetryState | null): TelemetryOptOut | null {
  if (isSet(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (OFF_VALUES.has((env.CP_TELEMETRY || '').toLowerCase())) return 'CP_TELEMETRY';
  if (brand.telemetry.rcOptOut) return 'rc';
  if (state?.enabled === false) return 'user';
  return null;
}

export interface StatusOptions {
  brand: Brand;
  env?: Env;
  pathOpts?: PathOpts;
}

// Precedence: no token beats everything, then `log` (the user asked to see the
// payload, whatever else is set), then the switches from broadest to narrowest.
export function telemetryStatus({
  brand,
  env = process.env,
  pathOpts,
}: StatusOptions): TelemetryStatus {
  const file = paths.telemetryPath(pathOpts);
  const state = readState(file);
  const id = state?.id ?? null;
  if (!brand.telemetry.token) return { mode: 'off', optOut: 'no-token', id, file };
  if ((env.CP_TELEMETRY || '').toLowerCase() === 'log')
    return { mode: 'log', optOut: null, id, file };
  const optOut = optOutOf(brand, env, state);
  return { mode: optOut ? 'off' : 'on', optOut, id, file };
}

/** One phrase for `doctor` and `telemetry status`, naming the switch that is in effect. */
export function describeTelemetry(status: TelemetryStatus, bin: string): string {
  if (status.mode === 'on') return 'enabled';
  if (status.mode === 'log') return 'log only (CP_TELEMETRY=log)';
  switch (status.optOut) {
    case 'no-token':
      return 'not configured';
    case 'rc':
      return 'disabled (.contextpluginsrc)';
    case 'user':
      return `disabled (${bin} telemetry disable)`;
    default:
      return `disabled (${status.optOut})`;
  }
}

/** `telemetry enable|disable`; false when the state file could not be written. */
export function setTelemetryEnabled(enabled: boolean, pathOpts?: PathOpts): boolean {
  const file = paths.telemetryPath(pathOpts);
  const state = readState(file) ?? { id: randomUUID() };
  return writeState(file, { ...state, enabled });
}

/** The marketplace as an event property: named only when it is the one this build ships with. */
export const marketplaceLabel = (brand: Brand): string =>
  brand.repo === brand.telemetry.defaultRepo ? brand.repo : 'custom';

export interface TelemetryOptions {
  brand: Brand;
  /** The CLI command this run is for; rides on every event. */
  command: string | null;
  version: string;
  deps?: Deps;
  pathOpts?: PathOpts;
  timeoutMs?: number;
  now?: () => number;
  newId?: () => string;
}

export interface Telemetry {
  readonly status: TelemetryStatus;
  track: TrackFn;
  /** Sends everything tracked so far in one request; never throws, never outlives the timeout. */
  flush(): Promise<void>;
}

export function createTelemetry({
  brand,
  command,
  version,
  deps = {},
  pathOpts,
  timeoutMs = FLUSH_TIMEOUT_MS,
  now = Date.now,
  newId = randomUUID,
}: TelemetryOptions): Telemetry {
  const env = deps.env || process.env;
  const fetchImpl: FetchLike = deps.fetchImpl || fetch;
  const status = telemetryStatus({ brand, env, pathOpts });
  const token = brand.telemetry.token;
  const queue: TelemetryEvent[] = [];
  const runId = newId();

  // The id is minted the first time there is something to send, so a read-only
  // command such as `list` leaves no file behind.
  function ensureState(): TelemetryState {
    const existing = readState(status.file);
    if (existing) return existing;
    const fresh = { id: newId() };
    writeState(status.file, fresh);
    return fresh;
  }

  function disclose(state: TelemetryState): void {
    if (state.noticeShown) return;
    log.notice(
      `${brand.displayName} collects anonymous usage data: the plugin id, the editor it went into, ` +
        `OS, Node and CLI version, and a random id for this machine. No paths, usernames or tokens. ` +
        `Opt out with '${brand.bin} telemetry disable' or DO_NOT_TRACK=1.`,
    );
    writeState(status.file, { ...state, noticeShown: true });
  }

  const common = (): Record<string, TelemetryValue> => ({
    command,
    cli_version: version,
    node_major: Number(process.versions.node.split('.')[0]),
    os: process.platform,
    arch: process.arch,
    ci: isCi(env),
    interactive: isInteractive(env),
    run_id: runId,
  });

  // Fixed fields last, so no event can rename the token or the identity.
  const payload = (state: TelemetryState, events: TelemetryEvent[]) =>
    events.map((e) => ({
      event: e.name,
      properties: {
        ...common(),
        ...e.properties,
        token,
        $device_id: state.id,
        distinct_id: `$device:${state.id}`,
        time: now(),
        $insert_id: newId(),
      },
    }));

  async function flush(): Promise<void> {
    const events = queue.splice(0);
    if (!events.length || status.mode === 'off' || !token) return;
    const state = ensureState();
    const body = payload(state, events);
    if (status.mode === 'log') {
      // One line per event, unwrapped, so the payload can be read or piped as JSON.
      for (const e of body) {
        log.notice(`telemetry (not sent): ${JSON.stringify(e)}`, { verbatim: true });
      }
      return;
    }
    disclose(state);
    try {
      const res = await fetchImpl(`${brand.telemetry.host}/track?ip=0&verbose=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      log.debug(`telemetry: ${res.status} ${(await res.text()).trim()}`);
    } catch (err) {
      log.debug(`telemetry: ${errorMessage(err)}`);
    }
  }

  return {
    status,
    track(name, properties = {}) {
      if (status.mode !== 'off') queue.push({ name, properties });
    },
    flush,
  };
}
