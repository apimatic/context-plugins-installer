import * as os from 'node:os';
import * as nodePath from 'node:path';

import { pathString, type PathArg } from '../types/file/paths.js';

/**
 * How the machine a path is read on treats paths. Both of these differ by
 * platform, and both used to be read from the host inside the function - which
 * meant the only way to exercise either branch was to be on that platform, so
 * the tests asserted the Windows answer everywhere and kept passing while the
 * code was wrong. As a parameter, both branches are testable from either host.
 */
export interface DisplayRules {
  /** What counts as a path boundary. */
  readonly boundaries: readonly string[];
  /** Whether two spellings can name one directory. */
  readonly foldsCase: boolean;
}

/**
 * On Windows a backslash separates and a path compares case-insensitively: a
 * home does not always agree with `APPDATA` about capitalisation while naming
 * the same directory. A forward slash is legal there too.
 *
 * On POSIX only a forward slash separates, a backslash is an ordinary character
 * in a filename, and two spellings are two directories - so folding them
 * printed `~` for a path that was not under the home at all.
 */
export const WINDOWS_DISPLAY: DisplayRules = {
  boundaries: [nodePath.win32.sep, '/'],
  foldsCase: true,
};
export const POSIX_DISPLAY: DisplayRules = { boundaries: [nodePath.posix.sep], foldsCase: false };

export const HOST_DISPLAY: DisplayRules =
  process.platform === 'win32' ? WINDOWS_DISPLAY : POSIX_DISPLAY;

const startsAtHome = (shown: string, root: string, rules: DisplayRules): boolean =>
  rules.foldsCase ? shown.toLowerCase().startsWith(root.toLowerCase()) : shown.startsWith(root);

const endsAtBoundary = (rest: string, rules: DisplayRules): boolean =>
  rest === '' || rules.boundaries.some((sep) => rest.startsWith(sep));

/**
 * A path as the user should read it, with their home directory shown as `~`.
 *
 * The home is a parameter wherever the caller has one, so a test can describe
 * another machine; only the default reaches for this one.
 */
export function path(
  target: PathArg,
  home: string = os.homedir(),
  rules: DisplayRules = HOST_DISPLAY,
): string {
  const shown = pathString(target);
  if (!shown || !home) return shown;

  // A trailing separator on the home would move where the boundary falls.
  const root = home.replace(/[/\\]+$/, '');
  // A home of '/' trims to nothing, and every string starts with nothing, so
  // without this every absolute path was rewritten as though it sat inside the
  // home. Reachable with HOME=/ in a minimal container.
  if (!root) return shown;
  if (!startsAtHome(shown, root, rules)) return shown;

  // The remainder must begin at a path boundary. Without that check a directory
  // whose name merely extends the home path was collapsed as though it sat
  // inside it: `/home/dev-config/Code/User` beside a home of `/home/dev` came
  // out as `~/-config/Code/User`, which reads like a real path inside the home
  // and is not one.
  const rest = shown.slice(root.length);
  if (!endsAtBoundary(rest, rules)) return shown;

  return `~${rest}`;
}

/** Imported as `f` at the call sites, so a message reads `${f.path(dir)}`. */
export const format = { path };
