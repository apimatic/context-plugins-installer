import type { MarketplaceLabel } from './brand.js';
import type { Failure } from './failure.js';
import type { HarnessName } from './harness.js';
import type { PluginId } from './ids/plugin-id.js';
import type { PluginSource, SourceKind } from './plugin-source.js';
import type { ErrorKind, TelemetryStatus, TelemetryVerb } from './telemetry.js';
import type { Manifest, ManifestEntry } from './installed-record.js';

// What a command did, as facts rather than prose. A prompts class renders these;
// a command reads them to decide which telemetry events to fire.

export interface InstallResult {
  /**
   * A `PluginId`, or null when the id never validated - which is the whole of
   * the "only once validated" rule, as a type. A command builds its events from
   * this field, so a raw argv string must not be able to reach it.
   */
  plugin: PluginId | null;
  targets: HarnessName[];
  /** Editors an earlier run installed into that this run left alone. */
  untouched?: HarnessName[];
  marketplace: string;
  /** Null for a source that has no ref: a directory on this machine. */
  ref: string | null;
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
  /**
   * What the run was asked to install, once parsed - null when the argument was
   * neither an id nor a path. A command reads two things off it that it must not
   * decide for itself: which `source_kind` to report, and whether the plugin id
   * may leave the machine at all.
   */
  source: PluginSource | null;
}

export interface UninstallResult {
  /** Null when the id never validated; see `InstallResult.plugin`. */
  plugin: PluginId | null;
  /**
   * Where the row this run acted on came from, rebuilt from its recorded key.
   * A command reads the same two things off it that install does: the kind to
   * report, and whether the plugin id may leave the machine - a plugin removed
   * from a directory withholds the name that directory gave it, exactly as
   * installing it did.
   */
  source: PluginSource | null;
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
 * One recorded plugin as `update` left it, as four shapes rather than one with
 * nullable fields - because which facts exist depends entirely on how far the
 * row got, and a command that reports on it must not have to guess. `plugin` is
 * on every arm because the grid prints one line per row whatever happened, and
 * it is the id *as the record spells it*: an unreadable row may not have a
 * valid one.
 *
 * - `updated`: an install ran and worked. One event per editor.
 * - `failed`: an install ran and did not. One event, whose `errorKind` says
 *   whether the action answered with a `Failure` (`user`) or threw
 *   (`unexpected`) - the distinction telemetry exists to make, and the reason
 *   this is not a boolean. `report` is absent for a throw; `stage` survives it.
 * - `unreadable`: this build cannot read the row. A record problem, not an
 *   install that failed, so it fails the run and reports nothing.
 * - `unavailable`: the source is not on this machine any more - a directory
 *   that was moved or deleted. Reported with its reason and warned about, and
 *   deliberately **not** a failure: a dev folder moving is an ordinary day, and
 *   a row that fails every `update` for ever is the one thing this command must
 *   never produce. `skipped` would lose the reason and `unreadable` would exit
 *   1, which is the shape of bug this repo has already fixed twice.
 * - `skipped`: no editor for it on this machine. Nothing was asked of it.
 */
export type UpdatedRow =
  | {
      outcome: 'updated';
      plugin: string;
      marketplace: MarketplaceLabel;
      report: InstallReport;
    }
  | {
      outcome: 'failed';
      plugin: string;
      /**
       * The id telemetry may carry, which is not always the id the run knew: a
       * plugin installed from a directory withholds its own. Taken off the
       * source through `reportableId`, so this field is already the answer and
       * a reader never has to re-derive it.
       */
      id: PluginId | null;
      sourceKind: SourceKind | null;
      marketplace: MarketplaceLabel;
      report: InstallReport | null;
      stage: InstallStage | null;
      error: string;
      errorKind: ErrorKind;
    }
  | { outcome: 'unreadable'; plugin: string; error: string }
  | { outcome: 'unavailable'; plugin: string; reason: string }
  | { outcome: 'skipped'; plugin: string };

export interface UpdateReport extends UpdateResult {
  rows: UpdatedRow[];
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
