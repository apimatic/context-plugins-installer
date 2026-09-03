import test from 'node:test';
import assert from 'node:assert';

import * as paths from '../src/paths.js';
import type { PathOpts } from '../src/types.js';

// The cross-platform table from the distribution plan, asserted from any host.
const WIN: PathOpts = {
  platform: 'win32',
  home: 'C:\\Users\\dev',
  env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
};
const MAC: PathOpts = { platform: 'darwin', home: '/Users/dev', env: {} };
const LINUX: PathOpts = { platform: 'linux', home: '/home/dev', env: {} };

test('VS Code user dir: Windows', () => {
  assert.equal(paths.vscodeUserDir(WIN), 'C:\\Users\\dev\\AppData\\Roaming\\Code\\User');
  assert.equal(
    paths.vscodeSettingsPath(WIN),
    'C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\settings.json',
  );
});

test('VS Code user dir: macOS', () => {
  assert.equal(paths.vscodeUserDir(MAC), '/Users/dev/Library/Application Support/Code/User');
});

test('VS Code user dir: Linux', () => {
  assert.equal(paths.vscodeUserDir(LINUX), '/home/dev/.config/Code/User');
});

test('VS Code user dir: Linux honours XDG_CONFIG_HOME', () => {
  assert.equal(
    paths.vscodeUserDir({ ...LINUX, env: { XDG_CONFIG_HOME: '/home/dev/xdg' } }),
    '/home/dev/xdg/Code/User',
  );
});

test('Windows falls back to the default APPDATA location when the variable is unset', () => {
  assert.equal(
    paths.vscodeUserDir({ ...WIN, env: {} }),
    'C:\\Users\\dev\\AppData\\Roaming\\Code\\User',
  );
});

test('Cursor local plugin dir is the same shape on all three platforms', () => {
  assert.equal(paths.cursorLocalDir(WIN), 'C:\\Users\\dev\\.cursor\\plugins\\local');
  assert.equal(paths.cursorLocalDir(MAC), '/Users/dev/.cursor/plugins/local');
  assert.equal(paths.cursorLocalDir(LINUX), '/home/dev/.cursor/plugins/local');
});

test('state dir, manifest, and VS Code store', () => {
  assert.equal(paths.stateDir(MAC), '/Users/dev/.context-plugins');
  assert.equal(paths.manifestPath(MAC), '/Users/dev/.context-plugins/installed.json');
  assert.equal(paths.vscodeStoreDir(MAC), '/Users/dev/.context-plugins/vscode');
  assert.equal(paths.stateDir(WIN), 'C:\\Users\\dev\\.context-plugins');
});

test('CP_STATE_DIR overrides the state dir', () => {
  assert.equal(paths.stateDir({ ...LINUX, env: { CP_STATE_DIR: '/tmp/state' } }), '/tmp/state');
});

test('CP_VSCODE_USER_DIR and CP_CURSOR_DIR override detection targets', () => {
  assert.equal(
    paths.vscodeUserDir({ ...LINUX, env: { CP_VSCODE_USER_DIR: '/tmp/code' } }),
    '/tmp/code',
  );
  assert.equal(
    paths.cursorRoot({ ...LINUX, env: { CP_CURSOR_DIR: '/tmp/cursor' } }),
    '/tmp/cursor',
  );
});

test('telemetry state sits next to the manifest and follows CP_STATE_DIR', () => {
  assert.equal(paths.telemetryPath(LINUX), '/home/dev/.context-plugins/telemetry.json');
  assert.equal(
    paths.telemetryPath({ ...WIN, env: { ...WIN.env, CP_STATE_DIR: 'D:\\state' } }),
    'D:\\state\\telemetry.json',
  );
});
