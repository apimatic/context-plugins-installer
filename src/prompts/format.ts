import * as os from 'node:os';
import * as nodePath from 'node:path';

import { pathString, type PathArg } from '../types/file/paths.js';

// The host's separator, plus the forward slash which is legal on Windows too.
// Not a bare backslash on every platform: on POSIX a file may legitimately be
// named with one, and accepting it there printed a path that does not exist.
const SEPARATORS = [nodePath.sep, '/'];

const endsAtBoundary = (rest: string): boolean =>
  rest === '' || SEPARATORS.some((sep) => rest.startsWith(sep));

/**
 * A path as the user should read it, with their home directory shown as `~`.
 *
 * The home is a parameter wherever the caller has one, so a test can describe
 * another machine; only the default reaches for this one.
 *
 * The comparison is case-insensitive because a Windows home does not always
 * agree with `APPDATA` about capitalisation, and both name the same directory.
 */
export function path(target: PathArg, home: string = os.homedir()): string {
  const shown = pathString(target);
  if (!shown || !home) return shown;

  // A trailing separator on the home would move where the boundary falls.
  const root = home.replace(/[/\\]+$/, '');
  // A home of '/' trims to nothing, and every string starts with nothing, so
  // without this every absolute path was rewritten as though it sat inside the
  // home. Reachable with HOME=/ in a minimal container.
  if (!root) return shown;
  if (!shown.toLowerCase().startsWith(root.toLowerCase())) return shown;

  // The remainder must begin at a path boundary. Without that check a directory
  // whose name merely extends the home path was collapsed as though it sat
  // inside it: `/home/dev-config/Code/User` beside a home of `/home/dev` came
  // out as `~/-config/Code/User`, which reads like a real path inside the home
  // and is not one.
  const rest = shown.slice(root.length);
  if (!endsAtBoundary(rest)) return shown;

  return `~${rest}`;
}

/** Imported as `f` at the call sites, so a message reads `${f.path(dir)}`. */
export const format = { path };
