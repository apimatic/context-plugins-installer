import * as fs from 'node:fs';

import { LOCAL_MARKETPLACE } from '../types/brand.js';
import type { PathOpts } from '../types/env.js';
import { Failure } from '../types/failure.js';
import type { DirectoryPath, FilePath } from '../types/file/paths.js';
import { DirectoryMarketplace } from '../types/marketplace-origin.js';
import { err, ok, type Result } from '../types/result.js';
import { errorMessage, isPlainObject, nonEmptyString, stripBom } from '../types/util.js';
import { copyDir, exists, rmrf, writeFileAtomic } from './file-system.js';
import * as paths from './paths.js';

// `claude plugin install` only takes `<id>@<marketplace>`, so a plugin
// installed from a path gets one generated here, shared by every path plugin.
// `plugins/` is the authority on what is staged, never the registry file.

const NEWLINE = String.fromCharCode(10);

const PLUGINS = 'plugins';

const registryFile = (root: DirectoryPath): FilePath =>
  root.file('.claude-plugin', 'marketplace.json');

export const localMarketplace = (opts?: PathOpts): DirectoryMarketplace =>
  new DirectoryMarketplace(paths.localMarketplaceDir(opts), LOCAL_MARKETPLACE);

function stagedPlugins(root: DirectoryPath): string[] {
  try {
    return (
      fs
        .readdirSync(root.join(PLUGINS).toString(), { withFileTypes: true })
        // A `.<plugin>.staging` scratch left by a kill mid-copy is not a plugin.
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    );
  } catch {
    return [];
  }
}

interface Registry {
  /** Every other field of the document, so a rewrite carries them through. */
  doc: Record<string, unknown>;
  rows: unknown[];
  /** False only when the file is there and could not be read; absent is true. */
  readable: boolean;
}

function readRegistry(file: FilePath): Registry {
  if (!exists(file)) return { doc: {}, rows: [], readable: true };
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(file.toString(), 'utf8')));
    if (!isPlainObject(data)) return { doc: {}, rows: [], readable: false };
    // A `plugins` present and not an array is unreadable, not empty.
    const rows: unknown = data.plugins;
    if (rows !== undefined && !Array.isArray(rows)) return { doc: data, rows: [], readable: false };
    return { doc: data, rows: Array.isArray(rows) ? rows : [], readable: true };
  } catch {
    return { doc: {}, rows: [], readable: false };
  }
}

const nameOf = (row: unknown): string | null =>
  isPlainObject(row) && nonEmptyString(row.name) ? row.name : null;

const entryFor = (plugin: string, description?: string): Record<string, unknown> => ({
  name: plugin,
  source: `./${PLUGINS}/${plugin}`,
  ...(description ? { description } : {}),
});

function write(file: FilePath, registry: Registry, rows: unknown[]): void {
  writeFileAtomic(
    file,
    JSON.stringify({ ...registry.doc, name: LOCAL_MARKETPLACE, plugins: rows }, null, 2) + NEWLINE,
  );
}

// Copy beside and swap rather than `replaceDir`, which removes the destination
// first and leaves a half-written folder if the copy fails partway.
function stageFiles(root: DirectoryPath, plugin: string, srcDir: DirectoryPath): void {
  const dest = root.join(PLUGINS, plugin);
  const pending = root.join(PLUGINS, `.${plugin}.staging`);
  rmrf(pending);
  try {
    copyDir(srcDir, pending);
    rmrf(dest);
    fs.renameSync(pending.toString(), dest.toString());
  } finally {
    rmrf(pending);
  }
}

export interface StageRequest {
  plugin: string;
  srcDir: DirectoryPath;
  description?: string;
}

/** A snapshot of `srcDir`, not a link: re-running the install re-takes it. */
export function stageLocalPlugin(
  { plugin, srcDir, description }: StageRequest,
  opts?: PathOpts,
): Result<DirectoryMarketplace, Failure> {
  const origin = localMarketplace(opts);
  const file = registryFile(origin.dir);
  try {
    stageFiles(origin.dir, plugin, srcDir);
    const registry = readRegistry(file);
    // An unreadable registry is rebuilt from the folders present, so the other
    // path plugins keep a row (their descriptions are lost).
    const rows = registry.readable
      ? registry.rows.filter((row) => nameOf(row) !== plugin)
      : stagedPlugins(origin.dir)
          .filter((name) => name !== plugin)
          .map((name) => entryFor(name));
    write(file, registry, [...rows, entryFor(plugin, description)]);
  } catch (e) {
    return err(
      new Failure(
        `Could not stage '${plugin}' for Claude Code in ${origin.dir}: ${errorMessage(e)}`,
        'Check that the state directory is writable, or set CP_STATE_DIR somewhere it is.',
      ),
    );
  }
  return ok(origin);
}

export interface Unstaged {
  remaining: number;
  /** The marketplace directory itself is gone, not just the plugin's folder. */
  removed: boolean;
}

export function unstageLocalPlugin(
  { plugin }: { plugin: string },
  opts?: PathOpts,
): Result<Unstaged, Failure> {
  const origin = localMarketplace(opts);
  const file = registryFile(origin.dir);
  try {
    if (!exists(origin.dir)) return ok({ remaining: 0, removed: true });
    rmrf(origin.dir.join(PLUGINS, plugin));

    const left = stagedPlugins(origin.dir);
    if (!left.length) {
      rmrf(origin.dir);
      return ok({ remaining: 0, removed: true });
    }
    // Left alone when unreadable: rewriting it from nothing would hide the
    // plugins still staged beside it.
    const registry = readRegistry(file);
    if (registry.readable) {
      write(
        file,
        registry,
        registry.rows.filter((row) => nameOf(row) !== plugin),
      );
    }
    return ok({ remaining: left.length, removed: false });
  } catch (e) {
    return err(
      new Failure(
        `Could not remove '${plugin}' from ${origin.dir}: ${errorMessage(e)}`,
        'Close anything reading that directory and try again.',
      ),
    );
  }
}
