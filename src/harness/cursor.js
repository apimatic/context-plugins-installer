'use strict';

const fs = require('fs');
const path = require('path');

const log = require('../log');
const paths = require('../paths');
const { replaceDir, rmrf, exists } = require('../util');

const name = 'cursor';
const title = 'Cursor';

const detect = (opts) => exists(paths.cursorRoot(opts));

const destFor = (plugin, opts) => path.join(paths.cursorLocalDir(opts), plugin);

async function install({ plugin, srcDir }, opts) {
  if (!detect(opts)) {
    log.warn('~/.cursor not found - Cursor not installed, skipping.');
    return false;
  }
  if (!exists(path.join(srcDir, '.cursor-plugin', 'plugin.json'))) {
    log.warn('Plugin has no .cursor-plugin/plugin.json - Cursor may not list it. Installing anyway.');
  }

  const dest = destFor(plugin, opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  replaceDir(srcDir, dest);

  log.ok(`Installed -> ${dest}`);
  log.info('Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window');
  return true;
}

async function uninstall({ plugin }, opts) {
  const dest = destFor(plugin, opts);
  if (!exists(dest)) {
    log.info(`Nothing to remove at ${dest}`);
    return false;
  }
  rmrf(dest);
  log.ok(`Removed ${dest}`);
  return true;
}

module.exports = { name, title, detect, install, uninstall, needsSource: true, destFor };
