import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../log.js';
import * as paths from '../paths.js';
import type { HarnessContext, HarnessName, HarnessOpts, UninstallOutcome } from '../types.js';
import { replaceDir, rmrf, exists, shortPath } from '../util.js';

export const name: HarnessName = 'cursor';
export const title = 'Cursor';
export const needsSource = true;

export const detect = (opts?: HarnessOpts): boolean => exists(paths.cursorRoot(opts));

export const destFor = (plugin: string, opts?: HarnessOpts): string =>
  path.join(paths.cursorLocalDir(opts), plugin);

export async function install({ plugin, srcDir }: HarnessContext, opts?: HarnessOpts) {
  if (!detect(opts)) {
    log.warn(
      `${shortPath(paths.cursorRoot(opts), opts?.home)} not found - Cursor not installed, skipping.`,
    );
    return false;
  }
  if (!srcDir) {
    log.warn('No plugin source was fetched - skipping Cursor.');
    return false;
  }
  if (!exists(path.join(srcDir, '.cursor-plugin', 'plugin.json'))) {
    log.warn(
      'Plugin has no .cursor-plugin/plugin.json - Cursor may not list it. Installing anyway.',
    );
  }

  const dest = destFor(plugin, opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  replaceDir(srcDir, dest);

  log.ok(`Installed -> ${shortPath(dest, opts?.home)}`);
  log.info('Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return true;
}

export async function uninstall(
  { plugin }: HarnessContext,
  opts?: HarnessOpts,
): Promise<UninstallOutcome> {
  // The plugin dir lives under Cursor's own root, so a root that is not here
  // is not an empty one: nothing about this plugin can be established, and
  // clearing the record off a path the install may never have used would strand
  // the copy it did use. Same answer as Claude Code with no CLI to ask.
  if (!detect(opts)) {
    log.warn(
      `${shortPath(paths.cursorRoot(opts), opts?.home)} not found - Cursor not installed, skipping.`,
    );
    return 'skipped';
  }
  const dest = destFor(plugin, opts);
  if (!exists(dest)) {
    log.info(`Nothing to remove at ${shortPath(dest, opts?.home)}`);
    return 'absent';
  }
  rmrf(dest);
  log.ok(`Removed -> ${shortPath(dest, opts?.home)}`);
  log.info('Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return 'removed';
}

export const location = (opts?: HarnessOpts): string =>
  shortPath(paths.cursorRoot(opts), opts?.home);
