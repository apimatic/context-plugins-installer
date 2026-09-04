import { NAMES } from './harness/index.js';
import { readRaw, sameEntry } from './infrastructure/manifest-store.js';
import type { FileArg } from './types/file/paths.js';
import type {
  ElidedTargets,
  IgnoredManifestEntry,
  Manifest,
  ManifestEntry,
} from './types/installed-record.js';
import { isPlainObject, nonEmptyString } from './util.js';

// The reading view of installed.json: what this build can act on, and what it
// could not represent. The bytes themselves are infrastructure/manifest-store,
// and the write operations are re-exported from there unchanged, because a
// writer has to work on the raw row rather than on anything sanitized here.
// Phase 3 turns all of this into types/manifest-context.
export {
  MANIFEST_VERSION,
  findRaw,
  remove,
  sameEntry,
  upsert,
  write,
  type EntryKey,
} from './infrastructure/manifest-store.js';

import type { EntryKey } from './infrastructure/manifest-store.js';

const str = (v: unknown): string | undefined => (nonEmptyString(v) ? v : undefined);

// An entry with no known target is dropped rather than kept as `targets: []`:
// resolveTargets reads an empty list as "every harness".
function sanitizeEntry(raw: unknown): ManifestEntry | null {
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

function describeIgnored(raw: unknown): IgnoredManifestEntry {
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
export function read(file: FileArg): Manifest {
  const data = readRaw(file);
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

export const find = (file: FileArg, { plugin, repo }: EntryKey): ManifestEntry | null =>
  read(file).plugins.find((p) => (repo ? sameEntry(p, { plugin, repo }) : p.plugin === plugin)) ||
  null;

// Target names this build does not know belong to whichever tool wrote them, so
// a rewrite has to carry them through: the sanitized read view cannot see them.
export function foreignTargets(raw: Record<string, unknown> | null): unknown[] {
  const targets = raw?.targets;
  return Array.isArray(targets) ? targets.filter((t) => !NAMES.includes(t)) : [];
}

export const list = (file: FileArg): ManifestEntry[] => read(file).plugins;
