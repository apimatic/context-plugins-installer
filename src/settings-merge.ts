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

// Comments blanked to spaces, offsets and line breaks preserved. Matching runs
// over this copy so a commented-out block cannot absorb the new entry or pass
// for a live one, while the offsets it yields still address the real text.
function maskComments(text: string): string {
  const out = text.split('');
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
        i += 1;
      }
      if (i < text.length) out[i] = ' ';
      if (i + 1 < text.length) out[i + 1] = ' ';
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
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

  // Tested against the real text, not the mask: a file holding nothing but
  // comments is not empty, and resetting it would throw them away.
  if (/^\s*$/.test(raw) || /^\s*\{\s*\}\s*$/.test(raw)) {
    writeKeepingBom(settingsPath, freshDocument(key, eolOf(raw) || '\n'), hadBom);
    return { action: 'reset', backup: null };
  }

  const mask = maskComments(raw);
  if (mask.includes(`"${key}"`)) return { action: 'already', backup: null };

  const eol = eolOf(raw);
  const entry = `"${key}": true`;
  let action: AddLocationResult['action'];
  let at: number;

  const open = new RegExp(`"${escapeRe(KEY)}"\\s*:\\s*\\{`).exec(mask);
  let insert: string;
  if (open) {
    // Prepended, so the last entry's comma is never touched.
    at = open.index + open[0].length;
    const empty = /^\s*\}/.test(mask.slice(at));
    action = empty ? 'inserted-empty' : 'inserted-existing';
    insert = ` ${entry}${empty ? ' ' : ','}`;
  } else {
    const brace = /^\s*\{/.exec(mask);
    // Nothing to splice into: no object opens this document. Saying so beats
    // writing the file back unchanged and reporting success.
    if (!brace) return { action: 'failed', backup: null };
    at = brace[0].length;
    action = 'inserted-key';
    insert = `${eol}    "${KEY}": { ${entry} },`;
  }

  const saved = backup(settingsPath);
  writeKeepingBom(settingsPath, raw.slice(0, at) + insert + raw.slice(at), hadBom);
  return { action, backup: saved };
}

export function removePluginLocation(settingsPath: string, dir: string): RemoveLocationResult {
  if (!fs.existsSync(settingsPath)) return { action: 'missing', backup: null };

  const key = toKey(dir);
  const original = fs.readFileSync(settingsPath, 'utf8');
  const hadBom = original.charCodeAt(0) === 0xfeff;
  const raw = stripBom(original);
  const mask = maskComments(raw);
  if (!mask.includes(`"${key}"`)) return { action: 'absent', backup: null };

  const esc = escapeRe(key);
  // Leading-comma form first, so removing the last entry leaves no dangling comma.
  const hit = [
    new RegExp(`,\\s*"${esc}"\\s*:\\s*true`),
    new RegExp(`"${esc}"\\s*:\\s*true\\s*,\\s*`),
    new RegExp(`\\s*"${esc}"\\s*:\\s*true\\s*`),
  ]
    .map((re) => re.exec(mask))
    .find((m): m is RegExpExecArray => m !== null);
  // The path is named in the file but not as an entry this tool wrote, so there
  // is nothing here to take out.
  if (!hit) return { action: 'absent', backup: null };

  const saved = backup(settingsPath);
  const out = raw.slice(0, hit.index) + raw.slice(hit.index + hit[0].length);
  writeKeepingBom(settingsPath, out, hadBom);
  return { action: 'removed', backup: saved };
}
