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

// The marketplace this tool generates so that Claude Code can install a plugin
// that came from a path: `claude plugin marketplace add` takes a directory
// holding `.claude-plugin/marketplace.json`, so we write one.
//
// One shared marketplace rather than one per plugin, so a machine with five
// path plugins still shows a single row in `claude plugin marketplace list`.
// That makes its registry file shared state, and it follows the same rule the
// installed-plugins record does: every row that is not the one being written
// rides through verbatim, and so does every other field of the document - a
// hand edit and a newer CLI both reach this file.
//
// The directory under `plugins/` is the authority on what is staged, not the
// registry: the registry can be truncated by a kill mid-write or a hand edit,
// and reading "no rows" from a file we could not parse must never be what
// decides to delete five plugins.

const NEWLINE = String.fromCharCode(10);

/** Where a staged plugin's files live, relative to the marketplace root. */
const PLUGINS = 'plugins';

const registryFile = (root: DirectoryPath): FilePath =>
  root.file('.claude-plugin', 'marketplace.json');

/**
 * The origin a path install addresses, staged or not. Constructing it is free
 * and reads nothing, which is what lets the action hand it to every harness
 * while only actually staging files when Claude Code is one of them.
 */
export const localMarketplace = (opts?: PathOpts): DirectoryMarketplace =>
  new DirectoryMarketplace(paths.localMarketplaceDir(opts), LOCAL_MARKETPLACE);

/** The plugin folders actually present, which is what "staged" means. */
function stagedPlugins(root: DirectoryPath): string[] {
  try {
    return fs
      .readdirSync(root.join(PLUGINS).toString(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface Registry {
  /** Every other field of the document, so a rewrite carries them through. */
  doc: Record<string, unknown>;
  rows: unknown[];
  /** False when the file is there but this build could not read it. */
  readable: boolean;
}

function readRegistry(file: FilePath): Registry {
  if (!exists(file)) return { doc: {}, rows: [], readable: true };
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(file.toString(), 'utf8')));
    if (!isPlainObject(data)) return { doc: {}, rows: [], readable: false };
    return { doc: data, rows: Array.isArray(data.plugins) ? data.plugins : [], readable: true };
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

/**
 * Replace one plugin's folder without a window in which it is half-written.
 * `replaceDir` removes its destination first, so a copy that fails partway
 * leaves the registry naming a directory that is now broken. This copies
 * beside it and swaps, which is the pattern `writeFileAtomic` already uses for
 * the registry itself.
 */
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
  /** Where the plugin's files are now - the user's own directory. */
  srcDir: DirectoryPath;
  description?: string;
}

/**
 * Put a plugin's files under the generated marketplace and name it in the
 * registry, so `claude plugin install <id>@<name>` can find it.
 *
 * A snapshot, not a link: what Claude installs is what was on disk when this
 * ran, and running the install again is what re-takes it. The `source` is a
 * relative path because that is what a marketplace entry may hold - it
 * resolves against the marketplace root, which is the directory Claude is
 * given.
 */
export function stageLocalPlugin(
  { plugin, srcDir, description }: StageRequest,
  opts?: PathOpts,
): Result<DirectoryMarketplace, Failure> {
  const origin = localMarketplace(opts);
  const file = registryFile(origin.dir);
  try {
    stageFiles(origin.dir, plugin, srcDir);
    const registry = readRegistry(file);
    // A registry this build cannot read is rebuilt from the folders that are
    // there, not replaced by this one entry: the alternative drops every other
    // path plugin's row while its files sit right beside it, and the rows are
    // reconstructible - only their descriptions are not.
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
  /** How many plugins the generated marketplace still holds. */
  remaining: number;
  /** Whether the marketplace directory itself is gone, so nothing should address it. */
  removed: boolean;
}

/**
 * Take a plugin back out. When it was the last one the whole directory goes,
 * because an empty generated marketplace is a row in
 * `claude plugin marketplace list` that offers nothing - the caller is told so
 * it can drop the registration too.
 *
 * What "the last one" means is read off `plugins/`, never off the registry: a
 * file this build could not parse looks exactly like a marketplace holding
 * nothing, and deleting four other plugins because of a truncated write is not
 * a trade this is allowed to make.
 */
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
    // Left alone when it could not be read: rewriting it from nothing would
    // tell Claude Code that the plugins still on disk beside it do not exist.
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
