import * as fs from 'node:fs';
import * as path from 'node:path';

import { NAMES } from './harness/index.js';
import type {
  ElidedTargets,
  IgnoredManifestEntry,
  Manifest,
  ManifestEntry,
} from './types/installed-record.js';
import { ensureDir, stripBom, isPlainObject, nonEmptyString } from './util.js';

export const MANIFEST_VERSION = 1;

// Entries are keyed by repo + plugin: the same id can exist in two marketplaces.
export interface EntryKey {
  plugin?: unknown;
  repo?: unknown;
}

interface RawManifest {
  version: number;
  plugins: unknown[];
}

export const sameEntry = (a: EntryKey, b: EntryKey): boolean =>
  a.plugin === b.plugin && (a.repo || '') === (b.repo || '');

const matches = (p: unknown, key: EntryKey): boolean => isPlainObject(p) && sameEntry(p, key);

const str = (v: unknown): string | undefined => (nonEmptyString(v) ? v : undefined);

// The write path works on this raw view: the file is shared with hand edits
// and other versions of this tool, so a row this build cannot read is not its
// to delete.
function readRaw(file: string): RawManifest {
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    const doc = isPlainObject(data) ? data : {};
    return {
      version:
        typeof doc.version === 'number' && Number.isInteger(doc.version)
          ? doc.version
          : MANIFEST_VERSION,
      plugins: Array.isArray(doc.plugins) ? doc.plugins : [],
    };
  } catch {
    return { version: MANIFEST_VERSION, plugins: [] };
  }
}

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
export function read(file: string): Manifest {
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

export function write(file: string, data: { plugins?: unknown[] }): RawManifest {
  ensureDir(path.dirname(file));
  const payload = { version: MANIFEST_VERSION, plugins: data.plugins || [] };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

const sortKey = (p: unknown): string => (isPlainObject(p) ? `${p.repo}/${p.plugin}` : '');

/** Takes the raw record type: uninstall writes back rows it read raw, foreign targets and all. */
export function upsert(file: string, entry: Record<string, unknown>): RawManifest {
  const data = readRaw(file);
  data.plugins = data.plugins.filter((p) => !matches(p, entry));
  data.plugins.push(entry);
  data.plugins.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return write(file, data);
}

export function remove(file: string, { plugin, repo }: EntryKey): number {
  const data = readRaw(file);
  const before = data.plugins.length;
  data.plugins = data.plugins.filter((p) => !matches(p, { plugin, repo }));
  write(file, data);
  return before - data.plugins.length;
}

export const find = (file: string, { plugin, repo }: EntryKey): ManifestEntry | null =>
  read(file).plugins.find((p) => (repo ? sameEntry(p, { plugin, repo }) : p.plugin === plugin)) ||
  null;

/** The raw row, shape unchecked, for entries the sanitized view hides. */
export const findRaw = (file: string, key: EntryKey): Record<string, unknown> | null =>
  readRaw(file).plugins.find((p): p is Record<string, unknown> => matches(p, key)) || null;

// Target names this build does not know belong to whichever tool wrote them, so
// a rewrite has to carry them through: the sanitized read view cannot see them.
export function foreignTargets(raw: Record<string, unknown> | null): unknown[] {
  const targets = raw?.targets;
  return Array.isArray(targets) ? targets.filter((t) => !NAMES.includes(t)) : [];
}

export const list = (file: string): ManifestEntry[] => read(file).plugins;
