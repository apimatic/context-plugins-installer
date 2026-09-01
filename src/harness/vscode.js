'use strict';

const path = require('path');

const log = require('../log');
const paths = require('../paths');
const { addPluginLocation, removePluginLocation } = require('../settings-merge');
const { replaceDir, rmrf, exists, shortPath } = require('../util');

// VS Code loads a plugin from anywhere on disk once the folder is listed in
// `chat.pluginLocations`, so we keep our own copy under the state dir rather
// than writing into VS Code's extension storage.
const name = 'vscode';
const title = 'VS Code';

const detect = (opts) => exists(paths.vscodeUserDir(opts));

const destFor = (plugin, opts) => path.join(paths.vscodeStoreDir(opts), plugin);

async function install({ plugin, srcDir }, opts) {
  if (!detect(opts)) {
    log.warn(
      `${shortPath(paths.vscodeUserDir(opts))} not found - VS Code not installed, skipping.`,
    );
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

async function uninstall({ plugin }, opts) {
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

const location = (opts) => shortPath(paths.vscodeUserDir(opts));

module.exports = { name, title, detect, location, install, uninstall, needsSource: true, destFor };
