import type { Env } from './env.js';
import type { DirectoryPath, FilePath } from './file/paths.js';
import type { Failure } from './failure.js';
import type { Result } from './result.js';
import type { EntryKey, RawManifest } from './installed-record.js';
import type { DomainEvent } from './events/domain-event.js';
import type { TelemetryLine, TelemetryStatus } from './telemetry.js';

// The interfaces through which this program reaches anything outside itself: a
// process, the network, a person at a terminal. Every one of them is the seam a
// test substitutes, which is why they are described here rather than inferred
// from whichever implementation happens to be first.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (file: string, args: string[], opts?: object) => Promise<RunResult>;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'error' | 'manual';
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface MaterializedSource {
  dir: DirectoryPath;
  cleanup: () => void;
  via: 'git' | 'api' | string;
}

/** The injection seam the test suite is built on; every field defaults to the real thing. */
export interface Deps {
  fetchImpl?: FetchLike;
  env?: Env;
  materialize?: (args: {
    repo: string;
    ref: string;
    sourcePath: string;
    deps?: Deps;
  }) => Promise<MaterializedSource>;
  /** `'cancelled'` for the interrupt, so a test can drive that path too. */
  confirm?: (
    question: string,
    defaultYes: boolean,
  ) => boolean | 'cancelled' | Promise<boolean | 'cancelled'>;
  which?: (cmd: string, env?: Env) => string | null;
  run?: RunCommand;
}

/**
 * `installed.json` as operations rather than bytes, which is what lets
 * `ManifestContext` hold the rules about a row without knowing there is a file.
 * Every operation works on the raw array: a row this build cannot read belongs
 * to whoever wrote it, so nothing here may sanitize on the way through.
 */
export interface ManifestStore {
  readRaw(): RawManifest;
  /**
   * Every row the key matches, not the first: folding the repo's case into the
   * key means one key can match rows an older build wrote in two spellings, and
   * `upsert` and `remove` already act on all of them.
   */
  findAllRaw(key: EntryKey): Record<string, unknown>[];
  upsert(entry: Record<string, unknown>): RawManifest;
  remove(key: EntryKey): number;
}

/**
 * The telemetry choice as `telemetry status|enable|disable` sees it. Reading and
 * writing the file are infrastructure; whether a broader switch overrides what
 * was written is the action's to notice.
 */
export interface TelemetrySettings {
  /** Where the choice is stored, for the message when it cannot be written. */
  readonly file: FilePath;
  status(): TelemetryStatus;
  setEnabled(enabled: boolean): Result<void, Failure>;
}

/**
 * Where a run's events go. Queue then send once, because a command fires its
 * events as it goes and the run should cost one request: the router owns the
 * one instance and flushes it in a `finally`.
 */
export interface Telemetry {
  /**
   * Queue what happened. Takes the event rather than a name and a bag of
   * properties, so the property names of the Mixpanel contract are declared by
   * one class each and nothing here can misspell or widen them.
   */
  report(event: DomainEvent): void;
  /**
   * Sends everything tracked so far in one request; never throws, never
   * outlives the timeout. Returns the lines it would have printed, in the order
   * it produced them, for the caller to put on the terminal.
   */
  flush(): Promise<TelemetryLine[]>;
}

export interface Prompter {
  /**
   * `'cancelled'` when the user interrupted the flow. An answer rather than an
   * exit or a throw, so the run it belongs to gets to stop by itself: the
   * action returns a cancelled result, the router exits 130, and the session
   * still cleans up on the way out.
   */
  confirm(question: string, defaultYes?: boolean): Promise<boolean | 'cancelled'>;
  close(): void;
}
