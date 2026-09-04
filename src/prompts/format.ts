import * as os from 'node:os';
import * as nodePath from 'node:path';

import { pathString, type PathArg } from '../types/file/paths.js';

/**
 * A path as the user should read it, with their home directory shown as `~`.
 *
 * The home is a parameter wherever the caller has one, so a test can describe
 * another machine; only the default reaches for this one. The separator is the
 * host's on purpose: this is what a person is about to read on this screen, not
 * a path being built for the target platform.
 */
export function path(target: PathArg, home: string = os.homedir()): string {
  const shown = pathString(target);
  if (!shown || !home) return shown;
  if (shown.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = shown.slice(home.length);
    const separator = rest.startsWith(nodePath.sep) || rest.startsWith('/') ? '' : nodePath.sep;
    return `~${separator}${rest}`;
  }
  return shown;
}

/** Imported as `f` at the call sites, so a message reads `${f.path(dir)}`. */
export const format = { path };
