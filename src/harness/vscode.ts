import * as path from 'node:path';

import { log } from '../log.js';
import * as paths from '../paths.js';
import { addPluginLocation, removePluginLocation } from '../settings-merge.js';
import type { HarnessContext, HarnessName, HarnessOpts } from '../types.js';
import { replaceDir, rmrf, exists, shortPath } from '../util.js';

// VS Code loads a plugin from anywhere on disk once the folder is listed in
// `chat.pluginLocations`, so we keep our own copy under the state dir rather
// than writing into VS Code's extension storage.
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
    // Unreachable through install.ts, which fetches first for every harness
    // that needs source; kept so the contract holds for any other caller.
    log.warn('No plugin source was fetched - skipping VS Code.');
    return false;
  }

  const dest = destFor(plugin, opts);
  replaceDir(srcDir, dest);

  const settings = paths.vscodeSettingsPath(opts);
  const result = addPluginLocation(settings, dest);

  log.ok(`Installed -> ${shortPath(dest)}`);
  if (result.action === 'already') log.info(`Already registered in ${shortPath(settings)}`);
  else log.info(`Registered in chat.pluginLocations (${shortPath(settings)})`);
  // The backup always happens; it is only worth mentioning when asked for detail.
  if (result.backup) log.debug(`Backed up settings.json -> ${path.basename(result.backup)}`);
  log.info('Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return true;
}

export async function uninstall({ plugin }: HarnessContext, opts?: HarnessOpts) {
  const dest = destFor(plugin, opts);
  const settings = paths.vscodeSettingsPath(opts);
  const result = removePluginLocation(settings, dest);
  const had = exists(dest);
  if (had) rmrf(dest);

  if (!had && result.action !== 'removed') {
    log.info(`Nothing to remove at ${shortPath(dest)}`);
    return false;
  }
  log.ok(`Removed -> ${shortPath(dest)}`);
  if (result.action === 'removed')
    log.info(`Unregistered from chat.pluginLocations (${shortPath(settings)})`);
  if (result.backup) log.debug(`Backed up settings.json -> ${path.basename(result.backup)}`);
  log.info('Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return true;
}

export const location = (opts?: HarnessOpts): string => shortPath(paths.vscodeUserDir(opts));
