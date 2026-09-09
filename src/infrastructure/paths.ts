import * as os from 'node:os';

import type { PathOpts } from '../types/env.js';
import { DirectoryPath, FilePath, rulesFor, type PathRules } from '../types/file/paths.js';

// Every path carries the rules of the *target* platform, not the host, so the
// cross-platform table is exactly assertable from any host.
function ctx(overrides: PathOpts = {}) {
  const platform = overrides.platform || process.platform;
  const rules = rulesFor(platform);
  return {
    platform,
    env: overrides.env || process.env,
    home: new DirectoryPath(overrides.home || os.homedir(), rules),
    rules,
  };
}

/**
 * What the user's own strings resolve against: the directory a relative path is
 * relative to, the home a `~` expands to, and the rules to join them by. Taken
 * from `PathOpts` first so a test never resolves against the directory it
 * happened to be run from.
 */
export function pathContext(o?: PathOpts): { cwd: string; home: string; rules: PathRules } {
  const c = ctx(o);
  return { cwd: o?.cwd || process.cwd(), home: c.home.toString(), rules: c.rules };
}

/** An override is taken as the user wrote it; an empty one is no override. */
const given = (value: string | undefined, rules: PathRules): DirectoryPath | undefined =>
  value ? new DirectoryPath(value, rules) : undefined;

export function stateDir(o?: PathOpts): DirectoryPath {
  const c = ctx(o);
  return given(c.env.CP_STATE_DIR, c.rules) ?? c.home.join('.context-plugins');
}

export function manifestPath(o?: PathOpts): FilePath {
  return stateDir(o).file('installed.json');
}

export function telemetryPath(o?: PathOpts): FilePath {
  return stateDir(o).file('telemetry.json');
}

/**
 * The marketplace this tool generates for plugins that came from a path. Under
 * the state dir, so `CP_STATE_DIR` sandboxes it in a test the way it does the
 * record - a generated marketplace written into a developer's real
 * `~/.context-plugins` by a test run would then be registered with their real
 * `claude`.
 */
export function localMarketplaceDir(o?: PathOpts): DirectoryPath {
  return stateDir(o).join('marketplace');
}

export function vscodeStoreDir(o?: PathOpts): DirectoryPath {
  return stateDir(o).join('vscode');
}

export function cursorRoot(o?: PathOpts): DirectoryPath {
  const c = ctx(o);
  return given(c.env.CP_CURSOR_DIR, c.rules) ?? c.home.join('.cursor');
}

export function cursorLocalDir(o?: PathOpts): DirectoryPath {
  return cursorRoot(o).join('plugins', 'local');
}

export function vscodeUserDir(o?: PathOpts): DirectoryPath {
  const c = ctx(o);
  const override = given(c.env.CP_VSCODE_USER_DIR, c.rules);
  if (override) return override;
  if (c.platform === 'win32') {
    const appData = given(c.env.APPDATA, c.rules) ?? c.home.join('AppData', 'Roaming');
    return appData.join('Code', 'User');
  }
  if (c.platform === 'darwin') {
    return c.home.join('Library', 'Application Support', 'Code', 'User');
  }
  const xdg = given(c.env.XDG_CONFIG_HOME, c.rules) ?? c.home.join('.config');
  return xdg.join('Code', 'User');
}

export function vscodeSettingsPath(o?: PathOpts): FilePath {
  return vscodeUserDir(o).file('settings.json');
}
