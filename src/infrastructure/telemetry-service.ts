import { randomUUID } from 'node:crypto';

import { BIN } from '../brand.js';
import * as paths from '../paths.js';
import type { Brand } from '../types/brand.js';
import type { Env, PathOpts } from '../types/env.js';
import { Failure } from '../types/failure.js';
import type { FilePath } from '../types/file/paths.js';
import type { Deps, FetchLike } from '../types/ports.js';
import type { Result } from '../types/result.js';
import type {
  TelemetryEvent,
  TelemetryLine,
  TelemetryOptOut,
  TelemetryStatus,
  TelemetryValue,
  TrackFn,
} from '../types/telemetry.js';
import { ENV_OFF, envFlag, errorMessage } from '../util.js';
import { isCi, isInteractive } from './environment.js';
import { track as postToMixpanel } from './mixpanel-client.js';
import {
  readState,
  withId,
  writeState,
  type StateRead,
  type TelemetryState,
} from './telemetry-state.js';

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
): { status: TelemetryStatus; read: StateRead; stateFile: FilePath } {
  const stateFile = paths.telemetryPath(pathOpts);
  const read = readState(stateFile);
  const id = read && read !== 'unreadable' ? read.id : null;
  // `status.file` is a reported string; `stateFile` is the path the writes use.
  const status = (mode: TelemetryStatus['mode'], optOut: TelemetryOptOut | null) => ({
    status: { mode, optOut, id, file: stateFile.toString() },
    read,
    stateFile,
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

/** `telemetry enable|disable`; the Failure names the file that could not be written. */
export function setTelemetryEnabled(enabled: boolean, pathOpts?: PathOpts): Result<void, Failure> {
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
  /**
   * Sends everything tracked so far in one request; never throws, never
   * outlives the timeout. Returns the lines it would have printed, in the order
   * it produced them, for the caller to put on the terminal.
   */
  flush(): Promise<TelemetryLine[]>;
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

  function disclose(file: FilePath, state: TelemetryState, lines: TelemetryLine[]): void {
    if (state.noticeShown) return;
    lines.push({
      kind: 'notice',
      text:
        `${brand.displayName} collects anonymous usage data: ${COLLECTED}. Nothing else: no file ` +
        `paths, usernames, messages or secrets. Opt out with '${BIN} telemetry disable' or ` +
        `DO_NOT_TRACK=1; CP_TELEMETRY=log shows each event instead of sending it.`,
      // Remembered only once it has been shown. Writing the flag here rather
      // than in `onShown` left a window - the awaited POST below sits inside it
      // - where an interrupt banked the flag against a notice nobody saw, and
      // `disclose` returns early ever after. A write that fails is the safe
      // direction: the notice simply appears again next run.
      onShown: () => void writeState(file, { ...state, noticeShown: true }),
    });
  }

  async function send(events: TelemetryEvent[], lines: TelemetryLine[]): Promise<void> {
    const env = deps.env || process.env;
    const { status, read, stateFile } = resolve(brand, env, pathOpts);
    const token = brand.telemetry?.token;
    if (status.mode === 'off' || !token) return;

    // A fresh id is persisted before anything is sent: without a stable id there
    // is no per-machine count, and without the file the notice would repeat.
    const base = read === 'unreadable' ? null : read;
    const state = withId(base, newId);
    if (state !== base) {
      const written = writeState(stateFile, state);
      if (!written.ok) {
        lines.push({ kind: 'debug', text: written.error.message });
        lines.push({ kind: 'debug', text: 'telemetry: no writable state directory; nothing sent' });
        return;
      }
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
        lines.push({
          kind: 'notice',
          text: `telemetry (not sent): ${JSON.stringify(e)}`,
          verbatim: true,
        });
      }
      return;
    }

    const fetchImpl: FetchLike | undefined = deps.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      lines.push({ kind: 'debug', text: 'telemetry: no fetch implementation; nothing sent' });
      return;
    }

    disclose(stateFile, state, lines);
    const sent = await postToMixpanel({
      host: brand.telemetry.host,
      body,
      fetchImpl,
      timeoutMs,
    });
    lines.push({
      kind: 'debug',
      text: sent.ok ? `telemetry: ${sent.value}` : `telemetry: ${sent.error.message}`,
    });
  }

  return {
    track(name, properties = {}) {
      queue.push({ name, properties });
    },
    async flush() {
      const lines: TelemetryLine[] = [];
      const events = queue.splice(0);
      if (!events.length) return lines;
      try {
        await send(events, lines);
      } catch (e) {
        lines.push({ kind: 'debug', text: `telemetry: ${errorMessage(e)}` });
      }
      return lines;
    },
  };
}
