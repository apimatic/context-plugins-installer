import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AddLocationResult, RemoveLocationResult } from './types.js';
import { ensureDir, timestamp, stripBom } from './util.js';

// settings.json is JSONC and users care about its formatting, so every edit is
// a targeted string splice - parsing and re-serializing would destroy both.
export const KEY = 'chat.pluginLocations';
const BOM = String.fromCharCode(0xfeff);

export const toKey = (dir: string): string => dir.replace(/\\/g, '/'); // forward slashes are valid JSON on Windows
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

export function freshDocument(key: string, eol = '\n'): string {
  return [`{`, `    "${KEY}": {`, `        "${key}": true`, `    }`, `}`, ``].join(eol);
}

function backup(file: string): string {
  const target = `${file}.bak-${timestamp()}`;
  fs.copyFileSync(file, target);
  return target;
}

function writeKeepingBom(file: string, text: string, hadBom: boolean): void {
  fs.writeFileSync(file, hadBom ? BOM + text : text, 'utf8');
}

export function addPluginLocation(settingsPath: string, dir: string): AddLocationResult {
  const key = toKey(dir);
  ensureDir(path.dirname(settingsPath));

  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, freshDocument(key), 'utf8');
    return { action: 'created', backup: null };
  }

  const original = fs.readFileSync(settingsPath, 'utf8');
  const hadBom = original.charCodeAt(0) === 0xfeff;
  const raw = stripBom(original);

  // Splicing into an empty document leaves a stray leading comma.
  if (/^\s*$/.test(raw) || /^\s*\{\s*\}\s*$/.test(raw)) {
    writeKeepingBom(settingsPath, freshDocument(key, eolOf(raw) || '\n'), hadBom);
    return { action: 'reset', backup: null };
  }

  if (raw.includes(`"${key}"`)) return { action: 'already', backup: null };

  const saved = backup(settingsPath);
  const eol = eolOf(raw);
  const entry = `"${key}": true`;
  let action: AddLocationResult['action'];
  let out: string;

  if (new RegExp(`"${escapeRe(KEY)}"\\s*:\\s*\\{\\s*\\}`).test(raw)) {
    out = raw.replace(
      new RegExp(`("${escapeRe(KEY)}"\\s*:\\s*\\{)\\s*\\}`),
      (_m, open: string) => `${open} ${entry} }`,
    );
    action = 'inserted-empty';
  } else if (new RegExp(`"${escapeRe(KEY)}"\\s*:\\s*\\{`).test(raw)) {
    // Prepended, so the last entry's comma is never touched.
    out = raw.replace(
      new RegExp(`("${escapeRe(KEY)}"\\s*:\\s*\\{)`),
      (_m, open: string) => `${open} ${entry},`,
    );
    action = 'inserted-existing';
  } else {
    out = raw.replace(/^(\s*\{)/, (_m, open: string) => `${open}${eol}    "${KEY}": { ${entry} },`);
    action = 'inserted-key';
  }

  writeKeepingBom(settingsPath, out, hadBom);
  return { action, backup: saved };
}

export function removePluginLocation(settingsPath: string, dir: string): RemoveLocationResult {
  if (!fs.existsSync(settingsPath)) return { action: 'missing', backup: null };

  const key = toKey(dir);
  const original = fs.readFileSync(settingsPath, 'utf8');
  const hadBom = original.charCodeAt(0) === 0xfeff;
  const raw = stripBom(original);
  if (!raw.includes(`"${key}"`)) return { action: 'absent', backup: null };

  const saved = backup(settingsPath);
  const esc = escapeRe(key);

  // Leading-comma form first, so removing the last entry leaves no dangling comma.
  let out = raw.replace(new RegExp(`,\\s*"${esc}"\\s*:\\s*true`), '');
  if (out === raw) out = raw.replace(new RegExp(`"${esc}"\\s*:\\s*true\\s*,\\s*`), '');
  if (out === raw) out = raw.replace(new RegExp(`\\s*"${esc}"\\s*:\\s*true\\s*`), '');

  writeKeepingBom(settingsPath, out, hadBom);
  return { action: 'removed', backup: saved };
}
