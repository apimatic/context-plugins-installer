import type { HarnessName } from './harness.js';

// `~/.context-plugins/installed.json` as this build reads it. The file is shared
// with hand edits and with other versions of this tool, so the read view
// reports what it could not represent rather than hiding it.

/** An entry read() could act on: at least one target this build knows. */
export interface ManifestEntry {
  plugin: string;
  repo?: string;
  marketplace?: string;
  ref?: string;
  targets: HarnessName[];
  installedAt?: string;
  /** Unknown fields round-trip through read/write on purpose. */
  [key: string]: unknown;
}

/** `repo` completes the entry key: the same plugin id can be in two marketplaces. */
export interface IgnoredManifestEntry {
  plugin: string | null;
  repo?: string;
  reason: string;
}

/** An entry read() listed, minus the target names this build does not know. */
export interface ElidedTargets {
  plugin: string;
  repo?: string;
  targets: string[];
}

export interface Manifest {
  version: number;
  plugins: ManifestEntry[];
  ignored: IgnoredManifestEntry[];
  elided: ElidedTargets[];
}
