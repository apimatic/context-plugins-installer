'use strict';

const fs = require('fs');
const path = require('path');
const { NAMES } = require('./harness');
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

const str = (v) => (typeof v === 'string' ? v : undefined);

/**
 * One recorded install, or null when the entry cannot be used.
 *
 * The manifest is just a file: hand-edited, or written by a different version
 * of this tool. An unknown target name would crash every `byName(...)` lookup
 * downstream, and an entry whose targets all fail that test must not survive
 * as `targets: []` - resolveTargets reads an empty list as "every harness",
 * which would turn a corrupt entry into installs nobody asked for. So an
 * entry keeps the targets this build knows and is dropped when none remain -
 * the same start-clean rule `read` applies to the file as a whole.
 */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.plugin !== 'string' || !raw.plugin) return null;
  const targets = (Array.isArray(raw.targets) ? raw.targets : []).filter((t) => NAMES.includes(t));
  if (!targets.length) return null;
  return {
    ...raw,
    repo: str(raw.repo),
    marketplace: str(raw.marketplace),
    ref: str(raw.ref),
    installedAt: str(raw.installedAt),
    targets,
  };
}

function read(file) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return {
      version: Number.isInteger(data.version) ? data.version : MANIFEST_VERSION,
      plugins: Array.isArray(data.plugins) ? data.plugins.map(sanitizeEntry).filter(Boolean) : [],
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
