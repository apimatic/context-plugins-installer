'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { addPluginLocation, removePluginLocation, toKey } = require('../src/settings-merge');
const { tmpDir, cleanupAll, parseJsonc } = require('./helpers');

test.after(cleanupAll);

const PLUGIN_DIR = 'C:\\Users\\dev\\.context-plugins\\vscode\\my-sdk';
const KEY = toKey(PLUGIN_DIR);

function settingsWith(content) {
  const dir = tmpDir('cp-settings-');
  const file = path.join(dir, 'settings.json');
  if (content !== null) fs.writeFileSync(file, content, 'utf8');
  return file;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const backupsIn = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-'));

// ---- the 8 shapes the PowerShell installer was validated against -------------

test('1. missing file is created with the key', () => {
  const file = settingsWith(null);
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'created');
  assert.equal(parseJsonc(read(file))['chat.pluginLocations'][KEY], true);
});

test('2. empty file is replaced with a clean document', () => {
  const file = settingsWith('   \n  ');
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'reset');
  assert.equal(parseJsonc(read(file))['chat.pluginLocations'][KEY], true);
});

test('3. "{}" is replaced rather than spliced (no stray comma)', () => {
  const file = settingsWith('{}\n');
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'reset');
  assert.ok(!read(file).includes('{,'));
  assert.equal(parseJsonc(read(file))['chat.pluginLocations'][KEY], true);
});

test('4. an already-registered key is a no-op with no backup', () => {
  const file = settingsWith(`{\n  "chat.pluginLocations": { "${KEY}": true }\n}\n`);
  const before = read(file);
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'already');
  assert.equal(read(file), before);
  assert.equal(backupsIn(file).length, 0);
});

test('5. empty chat.pluginLocations object gets the single entry', () => {
  const file = settingsWith('{\n  "editor.fontSize": 13,\n  "chat.pluginLocations": {}\n}\n');
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'inserted-empty');
  const parsed = parseJsonc(read(file));
  assert.equal(parsed['chat.pluginLocations'][KEY], true);
  assert.equal(parsed['editor.fontSize'], 13);
});

test('6. existing entries are preserved when prepending', () => {
  const other = 'C:/other/plugin';
  const file = settingsWith(`{\n  "chat.pluginLocations": {\n    "${other}": true\n  }\n}\n`);
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'inserted-existing');
  const parsed = parseJsonc(read(file));
  assert.equal(parsed['chat.pluginLocations'][KEY], true);
  assert.equal(parsed['chat.pluginLocations'][other], true);
});

test('7. a settings file without the key keeps its other settings', () => {
  const file = settingsWith('{\n  "editor.tabSize": 2,\n  "files.eol": "\\n"\n}\n');
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'inserted-key');
  const parsed = parseJsonc(read(file));
  assert.equal(parsed['chat.pluginLocations'][KEY], true);
  assert.equal(parsed['editor.tabSize'], 2);
  assert.equal(parsed['files.eol'], '\n');
});

test('8. JSONC comments and trailing commas survive the edit', () => {
  const source = [
    '{',
    '  // editor tweaks',
    '  "editor.tabSize": 2,',
    '  /* block comment */',
    '  "workbench.colorTheme": "Default Dark+",',
    '}',
    '',
  ].join('\n');
  const file = settingsWith(source);
  addPluginLocation(file, PLUGIN_DIR);
  const raw = read(file);
  assert.ok(raw.includes('// editor tweaks'), 'line comment kept');
  assert.ok(raw.includes('/* block comment */'), 'block comment kept');
  const parsed = parseJsonc(raw);
  assert.equal(parsed['chat.pluginLocations'][KEY], true);
  assert.equal(parsed['workbench.colorTheme'], 'Default Dark+');
});

// ---- surrounding behaviour ---------------------------------------------------

test('an edit backs up the original first', () => {
  const file = settingsWith('{\n  "editor.tabSize": 2\n}\n');
  const result = addPluginLocation(file, PLUGIN_DIR);
  assert.ok(result.backup, 'backup path returned');
  assert.match(path.basename(result.backup), /^settings\.json\.bak-\d{8}-\d{6}$/);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), '{\n  "editor.tabSize": 2\n}\n');
});

test('a UTF-8 BOM is preserved', () => {
  const bom = String.fromCharCode(0xfeff);
  const file = settingsWith(`${bom}{\n  "editor.tabSize": 2\n}\n`);
  addPluginLocation(file, PLUGIN_DIR);
  assert.equal(read(file).charCodeAt(0), 0xfeff);
  assert.equal(parseJsonc(read(file).slice(1))['chat.pluginLocations'][KEY], true);
});

test('CRLF files stay CRLF', () => {
  const file = settingsWith('{\r\n  "editor.tabSize": 2\r\n}\r\n');
  addPluginLocation(file, PLUGIN_DIR);
  const raw = read(file);
  assert.ok(raw.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(raw.replace(/\r\n/g, '')), 'no bare LF introduced');
});

test('backslashes in the directory become forward slashes in the key', () => {
  assert.equal(toKey('C:\\a\\b'), 'C:/a/b');
});

// ---- removal ------------------------------------------------------------------

test('remove: the only entry, leaving valid JSON', () => {
  const file = settingsWith(`{\n  "chat.pluginLocations": {\n    "${KEY}": true\n  }\n}\n`);
  const result = removePluginLocation(file, PLUGIN_DIR);
  assert.equal(result.action, 'removed');
  const parsed = parseJsonc(read(file));
  assert.deepEqual(parsed['chat.pluginLocations'], {});
});

test('remove: the last of several, without leaving a dangling comma', () => {
  const other = 'C:/other/plugin';
  const file = settingsWith(
    `{\n  "chat.pluginLocations": {\n    "${other}": true,\n    "${KEY}": true\n  }\n}\n`,
  );
  removePluginLocation(file, PLUGIN_DIR);
  const raw = read(file);
  assert.ok(!/,\s*}/.test(raw), `dangling comma in: ${raw}`);
  const parsed = parseJsonc(raw);
  assert.equal(parsed['chat.pluginLocations'][other], true);
  assert.equal(KEY in parsed['chat.pluginLocations'], false);
});

test('remove: the first of several', () => {
  const other = 'C:/other/plugin';
  const file = settingsWith(
    `{\n  "chat.pluginLocations": {\n    "${KEY}": true,\n    "${other}": true\n  }\n}\n`,
  );
  removePluginLocation(file, PLUGIN_DIR);
  const parsed = parseJsonc(read(file));
  assert.equal(parsed['chat.pluginLocations'][other], true);
  assert.equal(KEY in parsed['chat.pluginLocations'], false);
});

test('remove: absent key and missing file are both non-destructive', () => {
  const file = settingsWith('{\n  "editor.tabSize": 2\n}\n');
  assert.equal(removePluginLocation(file, PLUGIN_DIR).action, 'absent');
  assert.equal(read(file), '{\n  "editor.tabSize": 2\n}\n');

  const missing = path.join(tmpDir('cp-missing-'), 'settings.json');
  assert.equal(removePluginLocation(missing, PLUGIN_DIR).action, 'missing');
});
