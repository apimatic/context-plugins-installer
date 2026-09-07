import type { Failure } from './failure.js';
import type { HarnessName } from './harness.js';
import type { TelemetryStatus, TelemetryVerb } from './telemetry.js';
import type { Manifest, ManifestEntry } from './installed-record.js';

// What a command did, as facts rather than prose. A prompts class renders these;
// a command reads them to decide which telemetry events to fire.

export interface InstallResult {
  plugin: string;
  targets: HarnessName[];
  /** Editors an earlier run installed into that this run left alone. */
  untouched?: HarnessName[];
  marketplace: string;
  ref: string;
}

/** How far a run got; coarse on purpose, so no message travels with it. */
export type InstallStage = 'resolve' | 'harnesses' | 'fetch' | 'install';

/**
 * The install result plus what only telemetry reads. `stage` is written as the
 * run advances, which is what lets a failure say where it happened without a
 * mutable object threaded alongside.
 */
export interface InstallReport extends InstallResult {
  untouched: HarnessName[];
  stage: InstallStage;
  targetsExplicit: boolean;
  durationMs: number;
}

export interface UninstallResult {
  plugin: string;
  /** Editors something was actually removed from - not editors whose record was corrected. */
  targets: HarnessName[];
  /** Editors that were asked and went wrong. Non-empty means the run failed. */
  failed: HarnessName[];
}

export interface UpdateResult {
  updated: string[];
  failed: { plugin: string; error: string }[];
}

/**
 * What `installed` found. `entries` is already filtered to the editors asked
 * for, but each row still names every editor it is recorded for: `--targets`
 * chooses which plugins are listed, not what is said about them.
 */
export interface InstalledReport {
  entries: ManifestEntry[];
  /** The editors asked for, or every one this build knows. */
  want: readonly HarnessName[];
  /** Whether that narrows the run: neither an absent flag nor `all` does. */
  scoped: boolean;
  /** What the read view could not show, for the caller to warn about. */
  gaps: Manifest;
}

/**
 * What `telemetry` did. `verb` and `status` are both null when the command line
 * was refused before anything was read - the only case where nothing ran.
 */
export interface TelemetryReport {
  verb: TelemetryVerb | null;
  status: TelemetryStatus | null;
  /** The choice was saved, but a broader switch still decides what happens. */
  overridden: boolean;
  /** Why the file could not be written, for `--verbose`. */
  writeError: Failure | null;
}

export interface ListedPlugin {
  name: string;
  description: string;
  targets: HarnessName[];
  installed: boolean;
}

export interface ListResult {
  label: string;
  marketplace: string | null;
  repo: string;
  plugins: ListedPlugin[];
}

/**
 * `result` is exactly what `--json` prints, and its shape is a contract - so
 * what the read view could not show travels beside it rather than inside it.
 */
export interface ListReport {
  result: ListResult;
  gaps: Manifest;
}
