import { readRaw } from './infrastructure/manifest-store.js';
import type { FileArg } from './types/file/paths.js';
import {
  manifestView,
  sameEntry,
  type EntryKey,
  type Manifest,
  type ManifestEntry,
} from './types/installed-record.js';

// The reading view of installed.json: what this build can act on, and what it
// could not represent. The rules are types/installed-record, the bytes are
// infrastructure/manifest-store, and the write operations are re-exported from
// there unchanged, because a writer has to work on the raw row rather than on
// anything sanitized. Phase 3 turns all of this into types/manifest-context.
export { findRaw, remove, upsert, write } from './infrastructure/manifest-store.js';
export {
  MANIFEST_VERSION,
  foreignTargets,
  sameEntry,
  type EntryKey,
} from './types/installed-record.js';

export const read = (file: FileArg): Manifest => manifestView(readRaw(file));

export const find = (file: FileArg, { plugin, repo }: EntryKey): ManifestEntry | null =>
  read(file).plugins.find((p) => (repo ? sameEntry(p, { plugin, repo }) : p.plugin === plugin)) ||
  null;

export const list = (file: FileArg): ManifestEntry[] => read(file).plugins;
