import * as os from 'node:os';
import * as path from 'node:path';

import type { PathOpts } from './types.js';

// The joiner follows the *target* platform, not the host, so the cross-platform
// table is exactly assertable from any host.
function ctx(overrides: PathOpts = {}) {
  const platform = overrides.platform || process.platform;
  return {
    platform,
    env: overrides.env || process.env,
    home: overrides.home || os.homedir(),
    p: platform === 'win32' ? path.win32 : path.posix,
  };
}

export function stateDir(o?: PathOpts): string {
  const c = ctx(o);
  return c.env.CP_STATE_DIR || c.p.join(c.home, '.context-plugins');
}

export function manifestPath(o?: PathOpts): string {
  return ctx(o).p.join(stateDir(o), 'installed.json');
}

export function telemetryPath(o?: PathOpts): string {
  return ctx(o).p.join(stateDir(o), 'telemetry.json');
}

export function vscodeStoreDir(o?: PathOpts): string {
  return ctx(o).p.join(stateDir(o), 'vscode');
}

export function cursorRoot(o?: PathOpts): string {
  const c = ctx(o);
  return c.env.CP_CURSOR_DIR || c.p.join(c.home, '.cursor');
}

export function cursorLocalDir(o?: PathOpts): string {
  return ctx(o).p.join(cursorRoot(o), 'plugins', 'local');
}

export function vscodeUserDir(o?: PathOpts): string {
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

export function vscodeSettingsPath(o?: PathOpts): string {
  return ctx(o).p.join(vscodeUserDir(o), 'settings.json');
}
