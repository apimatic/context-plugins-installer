import * as path from 'node:path';

import { log } from '../log.js';
import * as paths from '../paths.js';
import { addPluginLocation, removePluginLocation, KEY, toKey } from '../settings-merge.js';
import type { HarnessContext, HarnessName, HarnessOpts, UninstallOutcome } from '../types.js';
import { replaceDir, rmrf, exists, shortPath } from '../util.js';

// VS Code loads a plugin from any folder listed in chat.pluginLocations, so the
// copy lives under this tool's state dir rather than in VS Code's storage.
export const name: HarnessName = 'vscode';
export const title = 'VS Code';
export const needsSource = true;

export const detect = (opts?: HarnessOpts): boolean => exists(paths.vscodeUserDir(opts));

export const destFor = (plugin: string, opts?: HarnessOpts): string =>
  path.join(paths.vscodeStoreDir(opts), plugin);

export async function install({ plugin, srcDir }: HarnessContext, opts?: HarnessOpts) {
  if (!detect(opts)) {
    log.warn(
      `${shortPath(paths.vscodeUserDir(opts), opts?.home)} not found - VS Code not installed, skipping.`,
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

  log.ok(`Installed -> ${shortPath(dest, opts?.home)}`);
  // The files are in place either way, so this stays a success with a caveat -
  // reporting a skip would leave the copy on disk with nothing recorded to remove it.
  if (result.action === 'failed') {
    log.warn(`Could not edit ${shortPath(settings, opts?.home)} - add this entry yourself:`);
    log.info(`"${KEY}": { "${toKey(dest)}": true }`);
  } else if (result.action === 'conflict') {
    // Reporting "already registered" here would be a green install of a plugin
    // VS Code never loads; a second entry would just leave a duplicate key.
    log.warn(
      `${shortPath(settings, opts?.home)} already names this path, but not as an entry that loads it.`,
    );
    log.info(`Make it read "${toKey(dest)}": true`);
  } else if (result.action === 'already') {
    log.info(`Already registered in ${shortPath(settings, opts?.home)}`);
  } else {
    log.info(`Registered in chat.pluginLocations (${shortPath(settings, opts?.home)})`);
  }
  if (result.backup) log.debug(`Backed up settings.json -> ${path.basename(result.backup)}`);
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

  // The settings file names this path in a form the splice does not recognise
  // (hand-edited to `false`, or a shape its patterns miss). Always say so: left
  // unmentioned it survives the uninstall, and the next install then reports
  // "Already registered" for an entry that never loads the plugin.
  if (result.action === 'unremovable') {
    log.warn(
      `${shortPath(settings, opts?.home)} names ${shortPath(dest, opts?.home)} in a form this tool did not write.`,
    );
    log.info('Remove that entry by hand - nothing here can take it out safely.');
  }
  // The record still follows the files below: a leftover settings entry is a
  // separate mess to clean up, not a reason to keep claiming an install.

  // The outcome follows the files, not that entry. No detect() gate either,
  // unlike Cursor: the copy lives in this tool's own state dir, so `had` is a
  // fact about the plugin even with VS Code missing - and with no copy there is
  // nothing for VS Code to load, whatever the settings file still says.
  if (!had && result.action !== 'removed') {
    log.info(`Nothing to remove at ${shortPath(dest, opts?.home)}`);
    return 'absent';
  }
  // Only claim the directory when there was one: with `had` false the entry in
  // settings.json is all that came out.
  if (had) log.ok(`Removed -> ${shortPath(dest, opts?.home)}`);
  else log.ok(`Nothing was at ${shortPath(dest, opts?.home)} - unregistered it`);
  if (result.action === 'removed')
    log.info(`Unregistered from chat.pluginLocations (${shortPath(settings, opts?.home)})`);
  if (result.backup) log.debug(`Backed up settings.json -> ${path.basename(result.backup)}`);
  log.info('Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return 'removed';
}

export const location = (opts?: HarnessOpts): string =>
  shortPath(paths.vscodeUserDir(opts), opts?.home);
