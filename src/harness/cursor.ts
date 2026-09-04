import * as path from 'node:path';

import { log } from '../log.js';
import * as paths from '../paths.js';
import type { DirectoryPath } from '../types/file/paths.js';
import { format as f } from '../prompts/format.js';
import type {
  HarnessContext,
  HarnessName,
  HarnessOpts,
  UninstallOutcome,
} from '../types/harness.js';
import { ensureDir, replaceDir, rmrf, exists } from '../util.js';

export const name: HarnessName = 'cursor';
export const title = 'Cursor';
export const needsSource = true;

export const detect = (opts?: HarnessOpts): boolean => exists(paths.cursorRoot(opts));

export const destFor = (plugin: string, opts?: HarnessOpts): DirectoryPath =>
  paths.cursorLocalDir(opts).join(plugin);

export async function install({ plugin, srcDir }: HarnessContext, opts?: HarnessOpts) {
  if (!detect(opts)) {
    log.warn(
      `${f.path(paths.cursorRoot(opts), opts?.home)} not found - Cursor not installed, skipping.`,
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
  ensureDir(dest.parent());
  replaceDir(srcDir, dest);

  log.ok(`Installed -> ${f.path(dest, opts?.home)}`);
  log.info('Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return true;
}

export async function uninstall(
  { plugin }: HarnessContext,
  opts?: HarnessOpts,
): Promise<UninstallOutcome> {
  // The plugin dir lives under Cursor's own root, so a missing root makes the
  // path unverifiable rather than empty.
  if (!detect(opts)) {
    log.warn(
      `${f.path(paths.cursorRoot(opts), opts?.home)} not found - Cursor not installed, skipping.`,
    );
    return 'skipped';
  }
  const dest = destFor(plugin, opts);
  if (!exists(dest)) {
    log.info(`Nothing to remove at ${f.path(dest, opts?.home)}`);
    return 'absent';
  }
  rmrf(dest);
  log.ok(`Removed -> ${f.path(dest, opts?.home)}`);
  log.info('Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return 'removed';
}

export const location = (opts?: HarnessOpts): string => f.path(paths.cursorRoot(opts), opts?.home);
