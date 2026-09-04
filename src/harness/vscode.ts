import { log } from '../log.js';
import * as paths from '../infrastructure/paths.js';
import { format as f } from '../prompts/format.js';
import {
  addPluginLocation,
  removePluginLocation,
  KEY,
  toKey,
} from '../infrastructure/vscode-settings.js';
import type { DirectoryPath } from '../types/file/paths.js';
import type {
  HarnessContext,
  HarnessName,
  HarnessOpts,
  UninstallOutcome,
} from '../types/harness.js';
import { exists, replaceDir, rmrf } from '../infrastructure/file-system.js';

// VS Code loads a plugin from any folder listed in chat.pluginLocations, so the
// copy lives under this tool's state dir rather than in VS Code's storage.
export const name: HarnessName = 'vscode';
export const title = 'VS Code';
export const needsSource = true;

export const detect = (opts?: HarnessOpts): boolean => exists(paths.vscodeUserDir(opts));

export const destFor = (plugin: string, opts?: HarnessOpts): DirectoryPath =>
  paths.vscodeStoreDir(opts).join(plugin);

export async function install({ plugin, srcDir }: HarnessContext, opts?: HarnessOpts) {
  if (!detect(opts)) {
    log.warn(
      `${f.path(paths.vscodeUserDir(opts), opts?.home)} not found - VS Code not installed, skipping.`,
    );
    return false;
  }
  if (!srcDir) {
    log.warn('No plugin source was fetched - skipping VS Code.');
    return false;
  }

  const dest = destFor(plugin, opts);
  replaceDir(srcDir, dest);

  const settings = paths.vscodeSettingsPath(opts);
  const result = addPluginLocation(settings, dest);

  log.ok(`Installed -> ${f.path(dest, opts?.home)}`);
  // The files are in place either way, so this stays a success with a caveat -
  // reporting a skip would leave the copy on disk with nothing recorded to remove it.
  if (result.action === 'failed') {
    log.warn(`Could not edit ${f.path(settings, opts?.home)} - add this entry yourself:`);
    log.info(`"${KEY}": { "${toKey(dest)}": true }`);
  } else if (result.action === 'conflict') {
    // "Already registered" here would be a green install of a plugin that never
    // loads, and a second entry would leave a duplicate key.
    log.warn(
      `${f.path(settings, opts?.home)} already names this path, but not as an entry that loads it.`,
    );
    log.info(`Make it read "${toKey(dest)}": true`);
  } else if (result.action === 'already') {
    log.info(`Already registered in ${f.path(settings, opts?.home)}`);
  } else {
    log.info(`Registered in chat.pluginLocations (${f.path(settings, opts?.home)})`);
  }
  if (result.backup) log.debug(`Backed up settings.json -> ${result.backup.name()}`);
  log.info('Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return true;
}

export async function uninstall(
  { plugin }: HarnessContext,
  opts?: HarnessOpts,
): Promise<UninstallOutcome> {
  const dest = destFor(plugin, opts);
  const settings = paths.vscodeSettingsPath(opts);
  const result = removePluginLocation(settings, dest);
  const had = exists(dest);
  if (had) rmrf(dest);

  // Always said: unmentioned, it survives the uninstall and the next install
  // reports "Already registered" for an entry that never loads the plugin.
  if (result.action === 'unremovable') {
    log.warn(
      `${f.path(settings, opts?.home)} names ${f.path(dest, opts?.home)} in a form this tool did not write.`,
    );
    log.info('Remove that entry by hand - nothing here can take it out safely.');
  }
  // The record still follows the files below: a leftover settings entry is a
  // separate mess to clean up, not a reason to keep claiming an install.

  // The outcome follows the files: with no copy there is nothing for VS Code to
  // load, whatever the settings say. No detect() gate, unlike Cursor - the copy
  // is in this tool's own state dir, readable either way.
  if (!had && result.action !== 'removed') {
    log.info(`Nothing to remove at ${f.path(dest, opts?.home)}`);
    return 'absent';
  }
  // Only claim the directory when there was one.
  if (had) log.ok(`Removed -> ${f.path(dest, opts?.home)}`);
  else log.ok(`Nothing was at ${f.path(dest, opts?.home)} - unregistered it`);
  if (result.action === 'removed')
    log.info(`Unregistered from chat.pluginLocations (${f.path(settings, opts?.home)})`);
  if (result.backup) log.debug(`Backed up settings.json -> ${result.backup.name()}`);
  log.info('Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return 'removed';
}

export const location = (opts?: HarnessOpts): string =>
  f.path(paths.vscodeUserDir(opts), opts?.home);
