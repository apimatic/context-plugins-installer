import { NAMES, isHarnessName, type HarnessName } from './harness.js';
import { RepoSlug } from './ids/repo-slug.js';
import { isPlainObject, nonEmptyString } from '../util.js';

// `~/.context-plugins/installed.json` as this build reads it, and every rule
// about one of its rows in one place: what a row means, which of its target
// names this build owns, and what it could not represent. The file is shared
// with hand edits and with other versions of this tool, so the read view
// reports what it dropped rather than hiding it, and a writer works from the
// raw row rather than from anything sanitized here.

export const MANIFEST_VERSION = 1;

/** Entries are keyed by repo + plugin: the same id can exist in two marketplaces. */
export interface EntryKey {
  plugin?: unknown;
  repo?: unknown;
}

/** The file as parsed, with no opinion about what a row means. */
export interface RawManifest {
  version: number;
  plugins: unknown[];
}

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

// The repo half is compared the way GitHub reads it - case-insensitively -
// because the Claude harness already did, and a run whose two halves disagree
// about whether `Acme/M` and `acme/m` are one repository writes a second row
// for a plugin that is already installed. The plugin half is kebab-case by
// validation, so there is no case to fold there.
export const sameEntry = (a: EntryKey, b: EntryKey): boolean =>
  a.plugin === b.plugin && RepoSlug.same(a.repo, b.repo);

export const matchesKey = (row: unknown, key: EntryKey): boolean =>
  isPlainObject(row) && sameEntry(row, key);

/**
 * What a row says this build should act on. `list` is a usable list of target
 * names; `unusable` is a row with nothing to act on per target (no `targets`,
 * or an empty one, which `read()` drops from its view anyway); `foreign` is a
 * target list this build cannot read - a shape it cannot parse, or an array
 * naming only names it does not know - which is never rebuilt and never dropped
 * without `--force`.
 */
export type RowShape = 'none' | 'list' | 'unusable' | 'foreign';

export function rowShape(recorded: Record<string, unknown> | null | undefined): RowShape {
  if (!recorded) return 'none';
  const { targets } = recorded;
  if (!Array.isArray(targets)) return targets == null ? 'unusable' : 'foreign';
  if (!targets.length) return 'unusable';
  // Only unknown names is as unreadable as a shape that will not parse, and a
  // normal uninstall produces it: `['cursor','zed']` becomes `['zed']`.
  return targets.some(isHarnessName) ? 'list' : 'foreign';
}

// Target names this build does not know belong to whichever tool wrote them, so
// a rewrite has to carry them through: the sanitized read view cannot see them.
export function foreignTargets(raw: Record<string, unknown> | null): unknown[] {
  const targets = raw?.targets;
  return Array.isArray(targets) ? targets.filter((t) => !NAMES.includes(t)) : [];
}

const str = (v: unknown): string | undefined => (nonEmptyString(v) ? v : undefined);

// An entry with no known target is dropped rather than kept as `targets: []`:
// resolveTargets reads an empty list as "every harness".
export function sanitizeEntry(raw: unknown): ManifestEntry | null {
  if (!isPlainObject(raw)) return null;
  const plugin = raw.plugin;
  if (!nonEmptyString(plugin)) return null;
  const rawTargets = raw.targets;
  const targets = Array.isArray(rawTargets) ? NAMES.filter((n) => rawTargets.includes(n)) : [];
  if (!targets.length) return null;
  return {
    ...raw,
    plugin,
    repo: str(raw.repo),
    marketplace: str(raw.marketplace),
    ref: str(raw.ref),
    installedAt: str(raw.installedAt),
    targets,
  };
}

// The same names foreignTargets keeps for the write path, rendered for a message
// and deduped the way sanitizeEntry dedupes the ones this build does know.
const unknownTargetNames = (raw: unknown): string[] => [
  ...new Set(
    foreignTargets(isPlainObject(raw) ? raw : null).map((t) =>
      nonEmptyString(t) ? t : JSON.stringify(t),
    ),
  ),
];

export function describeIgnored(raw: unknown): IgnoredManifestEntry {
  if (!isPlainObject(raw) || !nonEmptyString(raw.plugin)) {
    return { plugin: null, reason: 'not a plugin entry' };
  }
  const unknown = unknownTargetNames(raw);
  return {
    plugin: raw.plugin,
    repo: str(raw.repo),
    reason: unknown.length ? `unknown target(s): ${unknown.join(', ')}` : 'no recorded targets',
  };
}

// A row can be lossy without being dropped: one known target and one this build
// does not know reads as a shorter targets list than the file holds. That gap is
// reported too, so the display layer never quietly narrows a row.
export function manifestView(data: RawManifest): Manifest {
  const plugins: ManifestEntry[] = [];
  const ignored: IgnoredManifestEntry[] = [];
  const elided: ElidedTargets[] = [];
  for (const raw of data.plugins) {
    const entry = sanitizeEntry(raw);
    if (!entry) {
      ignored.push(describeIgnored(raw));
      continue;
    }
    plugins.push(entry);
    const unknown = unknownTargetNames(raw);
    if (unknown.length) elided.push({ plugin: entry.plugin, repo: entry.repo, targets: unknown });
  }
  return { version: data.version, plugins, ignored, elided };
}
