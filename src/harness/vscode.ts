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
      `${shortPath(paths.vscodeUserDir(opts))} not found - VS Code not installed, skipping.`,
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

  log.ok(`Installed -> ${shortPath(dest)}`);
  // The files are in place either way, so this stays a success with a caveat -
  // reporting a skip would leave the copy on disk with nothing recorded to remove it.
  if (result.action === 'failed') {
    log.warn(`Could not edit ${shortPath(settings)} - add this entry yourself:`);
    log.info(`"${KEY}": { "${toKey(dest)}": true }`);
  } else if (result.action === 'already') {
    log.info(`Already registered in ${shortPath(settings)}`);
  } else {
    log.info(`Registered in chat.pluginLocations (${shortPath(settings)})`);
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

  if (!had && result.action !== 'removed') {
    log.info(`Nothing to remove at ${shortPath(dest)}`);
    return 'absent';
  }
  log.ok(`Removed -> ${shortPath(dest)}`);
  if (result.action === 'removed')
    log.info(`Unregistered from chat.pluginLocations (${shortPath(settings)})`);
  if (result.backup) log.debug(`Backed up settings.json -> ${path.basename(result.backup)}`);
  log.info('Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return 'removed';
}

export const location = (opts?: HarnessOpts): string => shortPath(paths.vscodeUserDir(opts));
