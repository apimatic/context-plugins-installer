import * as os from 'node:os';

import { pathString, type PathArg } from '../types/file/paths.js';

const SEPARATORS = ['/', '\\'];

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
  if (!shown.toLowerCase().startsWith(root.toLowerCase())) return shown;

  // The remainder must begin at a path boundary. Without that check a directory
  // whose name merely extends the home path was collapsed as though it sat
  // inside it: `/home/dev-config` beside a home of `/home/dev` printed as
  // `~-config`, a path that does not exist and cannot be acted on.
  const rest = shown.slice(root.length);
  if (!endsAtBoundary(rest)) return shown;

  return `~${rest}`;
}

/** Imported as `f` at the call sites, so a message reads `${f.path(dir)}`. */
export const format = { path };
