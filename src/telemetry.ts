import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { log } from './log.js';
import * as paths from './paths.js';
import { isCi, isInteractive } from './prompt.js';
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
import {
  ENV_OFF,
  ensureDir,
  envFlag,
  errorCode,
  errorMessage,
  isPlainObject,
  nonEmptyString,
  stripBom,
} from './util.js';

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

/**
 * What an event may carry, in the words the notice and `telemetry status` use.
 * Keep it in step with `common` below and the properties install.ts sends.
 */
export const COLLECTED =
  'the plugin id, the editor it went into, the marketplace when it is the built-in one, ' +
  'the command, OS, CPU architecture, Node and CLI version, whether the run was interactive ' +
  'or in CI, how long it took, a random id for this machine, and an approximate location ' +
  '(city, region, country) that Mixpanel derives from the request address and then discards';

interface TelemetryState {
  id: string | null;
  enabled?: boolean;
  noticeShown?: boolean;
}

/** `null` is a missing file; `unreadable` is a file that exists but cannot be trusted. */
type StateRead = TelemetryState | null | 'unreadable';

// A missing file is the fresh-machine case. Anything else that cannot be read is
// not "absent": treating it so would drop a saved opt-out, so it fails closed.
function readState(file: string): StateRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = errorCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'unreadable';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return 'unreadable';
  }
  if (!isPlainObject(parsed)) return 'unreadable';
  const state: TelemetryState = { id: nonEmptyString(parsed.id) ? parsed.id : null };
  if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled;
  if (typeof parsed.noticeShown === 'boolean') state.noticeShown = parsed.noticeShown;
  return state;
}

// Written whole through a rename, so a crash mid-write cannot leave the half
// file that would read as unreadable above.
function writeState(file: string, state: TelemetryState): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.debug(`telemetry: could not write ${file}: ${errorMessage(err)}`);
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

const withId = (state: TelemetryState | null, newId: () => string): TelemetryState =>
  state?.id ? state : { ...state, id: newId() };

function optOutOf(brand: Brand, env: Env, read: StateRead): TelemetryOptOut | null {
  if (envFlag(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (ENV_OFF.has((env.CP_TELEMETRY || '').toLowerCase())) return 'CP_TELEMETRY';
  if (brand.telemetry.rcOptOut) return 'rc';
  if (read === 'unreadable') return 'state';
  if (read?.enabled === false) return 'user';
  return null;
}

// Precedence: no token beats everything, then `log` (the user asked to see the
// payload, whatever else is set), then the switches from broadest to narrowest.
function resolve(
  brand: Brand,
  env: Env,
  pathOpts?: PathOpts,
): { status: TelemetryStatus; read: StateRead } {
  const file = paths.telemetryPath(pathOpts);
  const read = readState(file);
  const id = read && read !== 'unreadable' ? read.id : null;
  const status = (mode: TelemetryStatus['mode'], optOut: TelemetryOptOut | null) => ({
    status: { mode, optOut, id, file },
    read,
  });
  if (!brand.telemetry?.token) return status('off', 'no-token');
  if ((env.CP_TELEMETRY || '').toLowerCase() === 'log') return status('log', null);
  const optOut = optOutOf(brand, env, read);
  return status(optOut ? 'off' : 'on', optOut);
}

export interface StatusOptions {
  brand: Brand;
  env?: Env;
  pathOpts?: PathOpts;
}

export const telemetryStatus = ({
  brand,
  env = process.env,
  pathOpts,
}: StatusOptions): TelemetryStatus => resolve(brand, env, pathOpts).status;

/** One phrase for `doctor` and `telemetry status`, naming the switch that is in effect. */
export function describeTelemetry(status: TelemetryStatus, bin: string): string {
  if (status.mode === 'on') return 'enabled';
  if (status.mode === 'log') return 'log only (CP_TELEMETRY=log)';
  switch (status.optOut) {
    case 'no-token':
      return 'not configured';
    case 'rc':
      return 'disabled (.contextpluginsrc)';
    case 'state':
      return 'disabled (telemetry.json could not be read)';
    case 'user':
      return `disabled (${bin} telemetry disable)`;
    default:
      return `disabled (${status.optOut ?? 'unknown'})`;
  }
}

/** `telemetry enable|disable`; false when the state file could not be written. */
export function setTelemetryEnabled(enabled: boolean, pathOpts?: PathOpts): boolean {
  const file = paths.telemetryPath(pathOpts);
  const read = readState(file);
  // An explicit choice may replace a file that could not be read; nothing else does.
  const base = read === 'unreadable' ? null : read;
  return writeState(file, { ...withId(base, randomUUID), enabled });
}

/** The marketplace as an event property: named only when it is the one this build ships with. */
export const marketplaceLabel = (brand: Brand): string =>
  brand.repo === brand.telemetry?.defaultRepo ? brand.repo : 'custom';

export interface TelemetryOptions {
  brand: Brand;
  /** The CLI command this run is for; rides on every event. */
  command: string | null;
  /** Read only once there is something to send. */
  version: () => string;
  deps?: Deps;
  pathOpts?: PathOpts;
  timeoutMs?: number;
  now?: () => number;
  newId?: () => string;
}

export interface Telemetry {
  track: TrackFn;
  /** Sends everything tracked so far in one request; never throws, never outlives the timeout. */
  flush(): Promise<void>;
}

// Construction does no I/O. The mode, the state file, the version and the fetch
// implementation are all resolved in flush(), and only once something was tracked,
// so a read-only command touches nothing and a missing global fetch breaks nothing.
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
  const queue: TelemetryEvent[] = [];
  const runId = newId();

  const versionOrUnknown = (): string => {
    try {
      return version();
    } catch {
      return 'unknown';
    }
  };

  function disclose(file: string, state: TelemetryState): void {
    if (state.noticeShown) return;
    log.notice(
      `${brand.displayName} collects anonymous usage data: ${COLLECTED}. Nothing else: no file ` +
        `paths, usernames, messages or secrets. Opt out with '${brand.bin} telemetry disable' or ` +
        `DO_NOT_TRACK=1; CP_TELEMETRY=log shows each event instead of sending it.`,
    );
    writeState(file, { ...state, noticeShown: true });
  }

  async function send(events: TelemetryEvent[]): Promise<void> {
    const env = deps.env || process.env;
    const { status, read } = resolve(brand, env, pathOpts);
    const token = brand.telemetry?.token;
    if (status.mode === 'off' || !token) return;

    // A fresh id is persisted before anything is sent: without a stable id there
    // is no per-machine count, and without the file the notice would repeat.
    const base = read === 'unreadable' ? null : read;
    const state = withId(base, newId);
    if (state !== base && !writeState(status.file, state)) {
      log.debug('telemetry: no writable state directory; nothing sent');
      return;
    }

    const common: Record<string, TelemetryValue> = {
      command,
      cli_version: versionOrUnknown(),
      node_major: Number(process.versions.node.split('.')[0]),
      os: process.platform,
      arch: process.arch,
      ci: isCi(env),
      interactive: isInteractive(env),
      run_id: runId,
    };
    // Fixed fields last, so no event can rename the token or the identity.
    const body = events.map((e) => ({
      event: e.name,
      properties: {
        ...common,
        ...e.properties,
        token,
        $device_id: state.id,
        distinct_id: `$device:${state.id}`,
        time: now(),
        $insert_id: newId(),
      },
    }));

    if (status.mode === 'log') {
      // One line per event, unwrapped, so the payload can be read or piped as JSON.
      for (const e of body) {
        log.notice(`telemetry (not sent): ${JSON.stringify(e)}`, { verbatim: true });
      }
      return;
    }

    const fetchImpl: FetchLike | undefined = deps.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      log.debug('telemetry: no fetch implementation; nothing sent');
      return;
    }

    disclose(status.file, state);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const res = await fetchImpl(`${brand.telemetry.host}/track?ip=1&verbose=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      log.debug(`telemetry: ${res.status} ${(await res.text()).trim()}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    track(name, properties = {}) {
      queue.push({ name, properties });
    },
    async flush() {
      const events = queue.splice(0);
      if (!events.length) return;
      try {
        await send(events);
      } catch (err) {
        log.debug(`telemetry: ${errorMessage(err)}`);
      }
    },
  };
}
