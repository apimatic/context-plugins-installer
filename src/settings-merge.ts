import * as fs from 'node:fs';

import {
  asFilePath,
  parentOf,
  pathString,
  type DirArg,
  type FileArg,
  type FilePath,
} from './types/file/paths.js';
import type { AddLocationResult, RemoveLocationResult } from './types/vscode-settings.js';
import { ensureDir, timestamp, stripBom } from './util.js';

// settings.json is JSONC and users care about its formatting, so every edit is
// a targeted string splice - parsing and re-serializing would destroy both.
export const KEY = 'chat.pluginLocations';
const BOM = String.fromCharCode(0xfeff);

export const toKey = (dir: DirArg): string => pathString(dir).replace(/\\/g, '/'); // forward slashes are valid JSON on Windows
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// As a key: a bare quoted match also hits the path used as another setting's value.
const namedAsKey = (mask: string, key: string): boolean =>
  new RegExp(`"${escapeRe(key)}"\\s*:`).test(mask);

/** The `"<key>": true` entry this tool writes, as opposed to any other shape. */
const entryFor = (mask: string, key: string): boolean =>
  new RegExp(`"${escapeRe(key)}"\\s*:\\s*true\\b`).test(mask);
const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

export function freshDocument(key: string, eol = '\n'): string {
  return [`{`, `    "${KEY}": {`, `        "${key}": true`, `    }`, `}`, ``].join(eol);
}

function backup(file: FilePath): FilePath {
  const target = file.withSuffix(`.bak-${timestamp()}`);
  fs.copyFileSync(file.toString(), target.toString());
  return target;
}

function writeKeepingBom(file: string, text: string, hadBom: boolean): void {
  fs.writeFileSync(file, hadBom ? BOM + text : text, 'utf8');
}

// The three scanner steps. Each takes the index of the construct's first
// character and returns the index just past it; the two comment forms blank
// what they consume, keeping line breaks so offsets and line numbers hold.

function skipString(text: string, from: number): number {
  let i = from + 1; // past the opening quote
  while (i < text.length) {
    // An escaped quote does not close the string.
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  return i;
}

function blankLineComment(text: string, out: string[], from: number): number {
  let i = from;
  while (i < text.length && text[i] !== '\n') out[i++] = ' ';
  return i;
}

function blankBlockComment(text: string, out: string[], from: number): number {
  out[from] = ' ';
  out[from + 1] = ' ';
  let i = from + 2;
  while (i < text.length) {
    if (text[i] === '*' && text[i + 1] === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      return i + 2;
    }
    if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
    i += 1;
  }
  return i; // unterminated: the rest of the file is comment
}

// A copy with comments blanked to spaces. Matching runs over this so a
// commented-out block cannot absorb the new entry or pass for a live one, while
// the offsets it yields still address the real text.
function maskComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') i = skipString(text, i);
    else if (c === '/' && text[i + 1] === '/') i = blankLineComment(text, out, i);
    else if (c === '/' && text[i + 1] === '*') i = blankBlockComment(text, out, i);
    else i += 1;
  }
  return out.join('');
}

export function addPluginLocation(settings: FileArg, dir: DirArg): AddLocationResult {
  const settingsFile = asFilePath(settings);
  const settingsPath = pathString(settings);
  const key = toKey(dir);
  ensureDir(parentOf(settingsFile));

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
  if (entryFor(mask, key)) return { action: 'already', backup: null };
  // A key, but not the `"<key>": true` this tool writes; a second entry would
  // only leave a duplicate key.
  if (namedAsKey(mask, key)) return { action: 'conflict', backup: null };

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

  const saved = backup(settingsFile);
  writeKeepingBom(settingsPath, raw.slice(0, at) + insert + raw.slice(at), hadBom);
  return { action, backup: saved };
}

export function removePluginLocation(settings: FileArg, dir: DirArg): RemoveLocationResult {
  const settingsFile = asFilePath(settings);
  const settingsPath = pathString(settings);
  if (!fs.existsSync(settingsPath)) return { action: 'missing', backup: null };

  const key = toKey(dir);
  const original = fs.readFileSync(settingsPath, 'utf8');
  const hadBom = original.charCodeAt(0) === 0xfeff;
  const raw = stripBom(original);
  const mask = maskComments(raw);
  if (!namedAsKey(mask, key)) return { action: 'absent', backup: null };

  const esc = escapeRe(key);
  // Leading-comma form first, so removing the last entry leaves no dangling comma.
  const hit = [
    new RegExp(`,\\s*"${esc}"\\s*:\\s*true`),
    new RegExp(`"${esc}"\\s*:\\s*true\\s*,\\s*`),
    new RegExp(`\\s*"${esc}"\\s*:\\s*true\\s*`),
  ]
    .map((re) => re.exec(mask))
    .find((m): m is RegExpExecArray => m !== null);
  // Named, but not as an entry this tool wrote - which is not absence.
  if (!hit) return { action: 'unremovable', backup: null };

  const saved = backup(settingsFile);
  const out = raw.slice(0, hit.index) + raw.slice(hit.index + hit[0].length);
  writeKeepingBom(settingsPath, out, hadBom);
  return { action: 'removed', backup: saved };
}
