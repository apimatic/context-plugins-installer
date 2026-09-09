import * as fs from 'node:fs';

import { LOCAL_MARKETPLACE } from '../types/brand.js';
import type { PathOpts } from '../types/env.js';
import { Failure } from '../types/failure.js';
import type { DirectoryPath, FilePath } from '../types/file/paths.js';
import { DirectoryMarketplace } from '../types/marketplace-origin.js';
import { err, ok, type Result } from '../types/result.js';
import { errorMessage, isPlainObject, nonEmptyString, stripBom } from '../types/util.js';
import { exists, replaceDir, rmrf, writeFileAtomic } from './file-system.js';
import * as paths from './paths.js';

// The marketplace this tool generates so that Claude Code can install a plugin
// that came from a path: `claude plugin marketplace add` takes a directory
// holding `.claude-plugin/marketplace.json`, so we write one.
//
// One shared marketplace rather than one per plugin, so a machine with five
// path plugins still shows a single row in `claude plugin marketplace list`.
// That makes its registry file shared state, and it follows the same rule the
// installed-plugins record does: every row that is not the one being written
// rides through verbatim, whatever this build makes of it. A hand edit and a
// newer CLI both reach this file.

const NEWLINE = String.fromCharCode(10);

const registryFile = (root: DirectoryPath): FilePath =>
  root.file('.claude-plugin', 'marketplace.json');

/** Where a staged plugin's files live, relative to the marketplace root. */
const PLUGINS = 'plugins';

/**
 * The origin a path install addresses, staged or not. Constructing it is free
 * and reads nothing, which is what lets the action hand it to every harness
 * while only actually staging files when Claude Code is one of them.
 */
export const localMarketplace = (opts?: PathOpts): DirectoryMarketplace =>
  new DirectoryMarketplace(paths.localMarketplaceDir(opts), LOCAL_MARKETPLACE);

/** The rows in the generated registry, or none when there is no readable file yet. */
function readRows(file: FilePath): unknown[] {
  if (!exists(file)) return [];
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(file.toString(), 'utf8')));
    return isPlainObject(data) && Array.isArray(data.plugins) ? data.plugins : [];
  } catch {
    // Unreadable is treated as empty rather than fatal, like the record: this is
    // state this tool wrote, and a truncated file must not make every path
    // install fail forever. The rows it held are lost, which is what the
    // atomic write below exists to prevent in the first place.
    return [];
  }
}

const nameOf = (row: unknown): string | null =>
  isPlainObject(row) && nonEmptyString(row.name) ? row.name : null;

function write(file: FilePath, rows: unknown[]): void {
  writeFileAtomic(
    file,
    JSON.stringify({ name: LOCAL_MARKETPLACE, plugins: rows }, null, 2) + NEWLINE,
  );
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
 * ran, and `update` is what re-takes it. The `source` is written as a relative
 * path because that is what a marketplace entry may hold - it resolves against
 * the marketplace root, which is the directory Claude was given.
 */
export function stageLocalPlugin(
  { plugin, srcDir, description }: StageRequest,
  opts?: PathOpts,
): Result<DirectoryMarketplace, Failure> {
  const origin = localMarketplace(opts);
  const file = registryFile(origin.dir);
  try {
    replaceDir(srcDir, origin.dir.join(PLUGINS, plugin));
    const rows = readRows(file).filter((row) => nameOf(row) !== plugin);
    rows.push({
      name: plugin,
      source: `./${PLUGINS}/${plugin}`,
      ...(description ? { description } : {}),
    });
    write(file, rows);
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
    const rows = readRows(file).filter((row) => nameOf(row) !== plugin);
    if (!rows.length) {
      rmrf(origin.dir);
      return ok({ remaining: 0, removed: true });
    }
    write(file, rows);
    return ok({ remaining: rows.length, removed: false });
  } catch (e) {
    return err(
      new Failure(
        `Could not remove '${plugin}' from ${origin.dir}: ${errorMessage(e)}`,
        'Close anything reading that directory and try again.',
      ),
    );
  }
}
