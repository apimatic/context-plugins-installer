// What an event may carry and which switch decided whether it goes.

/** Flat by design: a property is a fact about the run, never a structure that could carry more. */
export type TelemetryValue = string | number | boolean | null;

export interface TelemetryEvent {
  name: string;
  properties: Record<string, TelemetryValue>;
}

export type TrackFn = (name: string, properties?: Record<string, TelemetryValue>) => void;

/** `log` prints what would be sent, to stderr, and sends nothing. */
export type TelemetryMode = 'on' | 'off' | 'log';

/**
 * Which switch turned telemetry off; `user` is the state file `telemetry disable`
 * writes, `state` that same file when it exists but cannot be read.
 */
export type TelemetryOptOut =
  'no-token' | 'DO_NOT_TRACK' | 'CP_TELEMETRY' | 'rc' | 'state' | 'user';

export interface TelemetryStatus {
  mode: TelemetryMode;
  optOut: TelemetryOptOut | null;
  /** The anonymous machine id, once one has been minted. */
  id: string | null;
  file: string;
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
}
