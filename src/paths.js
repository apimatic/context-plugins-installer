'use strict';

const os = require('os');
const path = require('path');

// Every function takes an optional {platform, env, home} so the cross-platform
// table can be unit-tested from any host. The joiner is chosen per target
// platform (not the host), which keeps those assertions exact.
function ctx(overrides = {}) {
  const platform = overrides.platform || process.platform;
  return {
    platform,
    env: overrides.env || process.env,
    home: overrides.home || os.homedir(),
    p: platform === 'win32' ? path.win32 : path.posix,
  };
}

function stateDir(o) {
  const c = ctx(o);
  return c.env.CP_STATE_DIR || c.p.join(c.home, '.context-plugins');
}

function manifestPath(o) {
  return ctx(o).p.join(stateDir(o), 'installed.json');
}

function vscodeStoreDir(o) {
  return ctx(o).p.join(stateDir(o), 'vscode');
}

function cursorRoot(o) {
  const c = ctx(o);
  return c.env.CP_CURSOR_DIR || c.p.join(c.home, '.cursor');
}

function cursorLocalDir(o) {
  return ctx(o).p.join(cursorRoot(o), 'plugins', 'local');
}

function vscodeUserDir(o) {
  const c = ctx(o);
  if (c.env.CP_VSCODE_USER_DIR) return c.env.CP_VSCODE_USER_DIR;
  if (c.platform === 'win32') {
    const appData = c.env.APPDATA || c.p.join(c.home, 'AppData', 'Roaming');
    return c.p.join(appData, 'Code', 'User');
  }
  if (c.platform === 'darwin') {
    return c.p.join(c.home, 'Library', 'Application Support', 'Code', 'User');
  }
  const xdg = c.env.XDG_CONFIG_HOME || c.p.join(c.home, '.config');
  return c.p.join(xdg, 'Code', 'User');
}

function vscodeSettingsPath(o) {
  return ctx(o).p.join(vscodeUserDir(o), 'settings.json');
}

module.exports = {
  stateDir,
  manifestPath,
  vscodeStoreDir,
  cursorRoot,
  cursorLocalDir,
  vscodeUserDir,
  vscodeSettingsPath,
};
