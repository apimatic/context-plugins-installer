import type { Env } from './env.js';
import type { DirectoryPath, FilePath } from './file/paths.js';
import type { Failure } from './failure.js';
import type { Result } from './result.js';
import type { EntryKey, RawManifest } from './installed-record.js';
import type { EventSink } from './events/domain-event.js';
import type { TelemetryStatus } from './telemetry.js';

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
  confirm?: (question: string, defaultYes: boolean) => boolean | Promise<boolean>;
  which?: (cmd: string, env?: Env) => string | null;
  run?: RunCommand;
  /** Where install/uninstall report what they did; absent means nobody is listening. */
  track?: EventSink;
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

export interface Prompter {
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}
