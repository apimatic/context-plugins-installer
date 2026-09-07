import * as fs from 'node:fs';

import { pathString, type FileArg } from '../types/file/paths.js';
import {
  MANIFEST_VERSION,
  matchesKey,
  type EntryKey,
  type RawManifest,
} from '../types/installed-record.js';
import { isPlainObject, stripBom } from '../util.js';
import { writeFileAtomic } from './file-system.js';

// `~/.context-plugins/installed.json` as bytes: read whole, written whole, with
// no opinion about what a row means. That opinion is types/installed-record.ts,
// which is also where the key rule lives. The file is shared with hand edits and
// with other versions of this tool, so a row this build cannot read is not its
// to delete - which is why every operation here works on the raw array.

const NEWLINE = String.fromCharCode(10);

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

export function write(file: FileArg, data: { version?: number; plugins?: unknown[] }): RawManifest {
  const payload = {
    // A version this build does not know belongs to a newer CLI. `readRaw`
    // preserves it deliberately, and stamping our own here would erase the only
    // migration signal the format has - on an install that touched one row.
    version:
      typeof data.version === 'number' && Number.isInteger(data.version)
        ? data.version
        : MANIFEST_VERSION,
    plugins: data.plugins || [],
  };
  writeFileAtomic(file, JSON.stringify(payload, null, 2) + NEWLINE);
  return payload;
}

const sortKey = (p: unknown): string => (isPlainObject(p) ? `${p.repo}/${p.plugin}` : '');

/** Takes the raw record type: uninstall writes back rows it read raw, foreign targets and all. */
export function upsert(file: FileArg, entry: Record<string, unknown>): RawManifest {
  const data = readRaw(file);
  data.plugins = data.plugins.filter((p) => !matchesKey(p, entry));
  data.plugins.push(entry);
  data.plugins.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return write(file, data);
}

export function remove(file: FileArg, { plugin, repo }: EntryKey): number {
  const data = readRaw(file);
  const before = data.plugins.length;
  data.plugins = data.plugins.filter((p) => !matchesKey(p, { plugin, repo }));
  write(file, data);
  return before - data.plugins.length;
}

/** The raw row, shape unchecked, for entries the sanitized view hides. */
export const findRaw = (file: FileArg, key: EntryKey): Record<string, unknown> | null =>
  readRaw(file).plugins.find((p): p is Record<string, unknown> => matchesKey(p, key)) || null;
