import type { FilePath } from './file/paths.js';

// What an event may carry and which switch decided whether it goes.

/** Flat by design: a property is a fact about the run, never a structure that could carry more. */
export type TelemetryValue = string | number | boolean | null;

export interface TelemetryEvent {
  name: string;
  properties: Record<string, TelemetryValue>;
}

/**
 * Whose problem a failure was. A `Failure` an action returned is `user`: it has
 * a sentence and a hint, and the run said them. A throw out of an action is
 * `unexpected` - a bug, and the one thing a released build wants counted.
 */
export type ErrorKind = 'user' | 'unexpected';

/** `log` prints what would be sent, to stderr, and sends nothing. */
export type TelemetryMode = 'on' | 'off' | 'log';

/**
 * Which switch turned telemetry off; `user` is the state file `telemetry disable`
 * writes, `state` that same file when it exists but cannot be read.
 */
export type TelemetryOptOut = 'DO_NOT_TRACK' | 'CP_TELEMETRY' | 'rc' | 'state' | 'user';

/**
 * The one prose inventory of what leaves this machine. Printed by the one-time
 * notice and by `telemetry status`, so it lives where both can reach it - and
 * it has to stay in step with `common` in the service and the properties each
 * event class in `types/events/` declares.
 */
export const COLLECTED =
  'the plugin id - except for a plugin installed from a directory on this machine, whose ' +
  'name stays here - the editor it went into, whether the plugin came from a marketplace, ' +
  'a GitHub repository or a directory (never the path or the repository itself), ' +
  'the marketplace when it is the built-in one, ' +
  'the command, OS, CPU architecture, Node and CLI version, whether the run was interactive ' +
  'or in CI, how long it took, a random id for this machine, and an approximate location ' +
  '(city, region, country) that Mixpanel derives from the request address and then discards';

/** What `telemetry` was asked to do; nothing named reads as `status`. */
export type TelemetryVerb = 'status' | 'enable' | 'disable';

export function asTelemetryVerb(value: string | undefined): TelemetryVerb | null {
  if (value === undefined || value === 'status') return 'status';
  if (value === 'enable' || value === 'disable') return value;
  return null;
}

export interface TelemetryStatus {
  mode: TelemetryMode;
  optOut: TelemetryOptOut | null;
  /** The anonymous machine id, once one has been minted. */
  id: string | null;
  /** The id file. A path, not its string: the caller shortens it for display. */
  file: FilePath;
}

/**
 * Something telemetry produced while flushing, for its caller to print. The
 * sender never prints: it is infrastructure, and whether anyone hears a
 * diagnostic depends on --verbose, which is not its business to know.
 */
export interface TelemetryLine {
  kind: 'notice' | 'debug';
  text: string;
  /** notice only: print as written, without the usual wrapping. */
  verbatim?: boolean;
  /**
   * Called once the line has actually reached the terminal. This is how the
   * one-time disclosure is remembered only after it was shown: persisting that
   * first left a window - an awaited network POST sat in it - where an
   * interrupt suppressed the notice permanently.
   */
  onShown?: () => void;
}
