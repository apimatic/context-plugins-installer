import * as fs from 'node:fs';

import { parentOf, pathString, type FileArg } from '../types/file/paths.js';
import { isPlainObject, stripBom } from '../util.js';
import { ensureDir } from './file-system.js';

// `~/.context-plugins/installed.json` as bytes: read whole, written whole, with
// no opinion about what a row means. The file is shared with hand edits and with
// other versions of this tool, so a row this build cannot read is not its to
// delete - which is why every operation here works on the raw array and the
// sanitized view lives a layer up.

export const MANIFEST_VERSION = 1;

/** Entries are keyed by repo + plugin: the same id can exist in two marketplaces. */
export interface EntryKey {
  plugin?: unknown;
  repo?: unknown;
}

export interface RawManifest {
  version: number;
  plugins: unknown[];
}

export const sameEntry = (a: EntryKey, b: EntryKey): boolean =>
  a.plugin === b.plugin && (a.repo || '') === (b.repo || '');

const matches = (p: unknown, key: EntryKey): boolean => isPlainObject(p) && sameEntry(p, key);

/** An unreadable or missing file reads as empty: this is state, not configuration. */
export function readRaw(file: FileArg): RawManifest {
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(pathString(file), 'utf8')));
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

export function write(file: FileArg, data: { plugins?: unknown[] }): RawManifest {
  const target = pathString(file);
  ensureDir(parentOf(file));
  const payload = { version: MANIFEST_VERSION, plugins: data.plugins || [] };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

const sortKey = (p: unknown): string => (isPlainObject(p) ? `${p.repo}/${p.plugin}` : '');

/** Takes the raw record type: uninstall writes back rows it read raw, foreign targets and all. */
export function upsert(file: FileArg, entry: Record<string, unknown>): RawManifest {
  const data = readRaw(file);
  data.plugins = data.plugins.filter((p) => !matches(p, entry));
  data.plugins.push(entry);
  data.plugins.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return write(file, data);
}

export function remove(file: FileArg, { plugin, repo }: EntryKey): number {
  const data = readRaw(file);
  const before = data.plugins.length;
  data.plugins = data.plugins.filter((p) => !matches(p, { plugin, repo }));
  write(file, data);
  return before - data.plugins.length;
}

/** The raw row, shape unchecked, for entries the sanitized view hides. */
export const findRaw = (file: FileArg, key: EntryKey): Record<string, unknown> | null =>
  readRaw(file).plugins.find((p): p is Record<string, unknown> => matches(p, key)) || null;
