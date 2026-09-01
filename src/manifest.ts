import * as fs from 'node:fs';
import * as path from 'node:path';

import { NAMES } from './harness/index.js';
import type { IgnoredManifestEntry, Manifest, ManifestEntry } from './types.js';
import { ensureDir, stripBom, isPlainObject, nonEmptyString } from './util.js';

/**
 * ~/.context-plugins/installed.json - a single state file, so one update pass
 * covers everything installed on the machine.
 *
 * Entries are keyed by repo + plugin rather than plugin alone, because the same
 * plugin id can legitimately exist in more than one marketplace.
 */
export const MANIFEST_VERSION = 1;

/** What identifies an entry: the plugin id plus the marketplace repo it came from. */
export interface EntryKey {
  plugin?: unknown;
  repo?: unknown;
}

/** The file as it sits on disk: entries untouched, shape unchecked. */
interface RawManifest {
  version: number;
  plugins: unknown[];
}

export const sameEntry = (a: EntryKey, b: EntryKey): boolean =>
  a.plugin === b.plugin && (a.repo || '') === (b.repo || '');

const matches = (p: unknown, key: EntryKey): boolean => isPlainObject(p) && sameEntry(p, key);

const str = (v: unknown): string | undefined => (nonEmptyString(v) ? v : undefined);

/**
 * The file as it sits on disk, entries untouched.
 *
 * The write path works on this view: the manifest is shared with hand edits
 * and with other versions of this tool, so an entry this build cannot read is
 * not this build's to delete. upsert and remove replace exactly the entry
 * they were asked about and carry everything else through verbatim.
 */
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
    // Missing or corrupt: start clean rather than block the install.
    return { version: MANIFEST_VERSION, plugins: [] };
  }
}

/**
 * One recorded install, or null when the entry cannot be acted on.
 *
 * An unknown target name would crash every `byName(...)` lookup downstream,
 * and an entry whose targets all fail that test must not survive as
 * `targets: []` - resolveTargets reads an empty list as "every harness",
 * which would turn a corrupt entry into installs nobody asked for. So an
 * entry keeps the targets this build knows (deduped, canonical order) and
 * falls out of the sanitized view when none remain. It stays on disk either
 * way; read() names it in `ignored` so commands can say so.
 */
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

/** Why read() ignored a raw entry - named so the CLI can say it out loud. */
function describeIgnored(raw: unknown): IgnoredManifestEntry {
  if (!isPlainObject(raw) || !nonEmptyString(raw.plugin)) {
    return { plugin: null, reason: 'not a plugin entry' };
  }
  const rawTargets = raw.targets;
  const unknown: unknown[] = Array.isArray(rawTargets)
    ? rawTargets.filter((t) => !NAMES.includes(t))
    : [];
  return {
    plugin: raw.plugin,
    reason: unknown.length ? `unknown target(s): ${unknown.join(', ')}` : 'no recorded targets',
  };
}

/** The entries this build can act on, plus a note of what it had to ignore. */
export function read(file: string): Manifest {
  const data = readRaw(file);
  const plugins: ManifestEntry[] = [];
  const ignored: IgnoredManifestEntry[] = [];
  for (const raw of data.plugins) {
    const entry = sanitizeEntry(raw);
    if (entry) plugins.push(entry);
    else ignored.push(describeIgnored(raw));
  }
  return { version: data.version, plugins, ignored };
}

export function write(file: string, data: { plugins?: unknown[] }): RawManifest {
  ensureDir(path.dirname(file));
  const payload = { version: MANIFEST_VERSION, plugins: data.plugins || [] };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

const sortKey = (p: unknown): string => (isPlainObject(p) ? `${p.repo}/${p.plugin}` : '');

/**
 * Writes the entry as given. Typed as the raw record on purpose: install
 * passes a fresh ManifestEntry, while uninstall writes back a row it read
 * raw (foreign targets and all), and both must round-trip untouched.
 */
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

/**
 * The raw recorded entry, shape unchecked. uninstall reads recorded state -
 * the marketplace name, the target list to shrink - for entries the sanitized
 * view hides, so removing a row this build cannot fully read still works
 * offline and still updates the record.
 */
export const findRaw = (file: string, key: EntryKey): Record<string, unknown> | null =>
  readRaw(file).plugins.find((p): p is Record<string, unknown> => matches(p, key)) || null;

export const list = (file: string): ManifestEntry[] => read(file).plugins;
