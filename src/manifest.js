'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, stripBom } = require('./util');

/**
 * ~/.context-plugins/installed.json - a single state file, so one update pass
 * covers everything installed on the machine.
 *
 * Entries are keyed by repo + plugin rather than plugin alone, because the same
 * plugin id can legitimately exist in more than one marketplace.
 */
const MANIFEST_VERSION = 1;

const sameEntry = (a, b) => a.plugin === b.plugin && (a.repo || '') === (b.repo || '');

function read(file) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return {
      version: data.version || MANIFEST_VERSION,
      plugins: Array.isArray(data.plugins) ? data.plugins.filter((p) => p && p.plugin) : [],
    };
  } catch {
    // Missing or corrupt: start clean rather than block the install.
    return { version: MANIFEST_VERSION, plugins: [] };
  }
}

function write(file, data) {
  ensureDir(path.dirname(file));
  const payload = { version: MANIFEST_VERSION, plugins: data.plugins || [] };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function upsert(file, entry) {
  const data = read(file);
  data.plugins = data.plugins.filter((p) => !sameEntry(p, entry));
  data.plugins.push(entry);
  data.plugins.sort((a, b) => `${a.repo}/${a.plugin}`.localeCompare(`${b.repo}/${b.plugin}`));
  return write(file, data);
}

function remove(file, { plugin, repo }) {
  const data = read(file);
  const before = data.plugins.length;
  data.plugins = data.plugins.filter((p) => !sameEntry(p, { plugin, repo }));
  write(file, data);
  return before - data.plugins.length;
}

const find = (file, { plugin, repo }) =>
  read(file).plugins.find((p) => (repo ? sameEntry(p, { plugin, repo }) : p.plugin === plugin)) ||
  null;

const list = (file) => read(file).plugins;

module.exports = { MANIFEST_VERSION, read, write, upsert, remove, find, list, sameEntry };
