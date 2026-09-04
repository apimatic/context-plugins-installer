import type { HarnessName } from './harness.js';

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
