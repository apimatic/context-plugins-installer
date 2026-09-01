'use strict';

const fs = require('fs');
const path = require('path');
const { NAMES } = require('./harness');
const { ensureDir, stripBom, isPlainObject, nonEmptyString } = require('./util');

/**
 * ~/.context-plugins/installed.json - a single state file, so one update pass
 * covers everything installed on the machine.
 *
 * Entries are keyed by repo + plugin rather than plugin alone, because the same
 * plugin id can legitimately exist in more than one marketplace.
 */
const MANIFEST_VERSION = 1;

const sameEntry = (a, b) => a.plugin === b.plugin && (a.repo || '') === (b.repo || '');

const matches = (p, key) => isPlainObject(p) && sameEntry(p, key);

const str = (v) => (nonEmptyString(v) ? v : undefined);

/**
 * The file as it sits on disk, entries untouched.
 *
 * The write path works on this view: the manifest is shared with hand edits
 * and with other versions of this tool, so an entry this build cannot read is
 * not this build's to delete. upsert and remove replace exactly the entry
 * they were asked about and carry everything else through verbatim.
 */
function readRaw(file) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return {
      version: Number.isInteger(data.version) ? data.version : MANIFEST_VERSION,
      plugins: Array.isArray(data.plugins) ? data.plugins : [],
    };
  } catch {
    // Missing or corrupt: start clean rather than block the install.
    return { version: MANIFEST_VERSION, plugins: [] };
  }
}

/**
 * One recorded install, or null when the entry cannot be acted on.
 *
 * An unknown target name would crash every `byName(...)` lookup downstream,
 * and an entry whose targets all fail that test must not survive as
 * `targets: []` - resolveTargets reads an empty list as "every harness",
 * which would turn a corrupt entry into installs nobody asked for. So an
 * entry keeps the targets this build knows (deduped, canonical order) and
 * falls out of the sanitized view when none remain. It stays on disk either
 * way; read() names it in `ignored` so commands can say so.
 */
function sanitizeEntry(raw) {
  if (!isPlainObject(raw) || !nonEmptyString(raw.plugin)) return null;
  const targets = Array.isArray(raw.targets) ? NAMES.filter((n) => raw.targets.includes(n)) : [];
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

/** Why read() ignored a raw entry - named so the CLI can say it out loud. */
function describeIgnored(raw) {
  if (!isPlainObject(raw) || !nonEmptyString(raw.plugin)) {
    return { plugin: null, reason: 'not a plugin entry' };
  }
  const unknown = Array.isArray(raw.targets) ? raw.targets.filter((t) => !NAMES.includes(t)) : [];
  return {
    plugin: raw.plugin,
    reason: unknown.length ? `unknown target(s): ${unknown.join(', ')}` : 'no recorded targets',
  };
}

/** The entries this build can act on, plus a note of what it had to ignore. */
function read(file) {
  const data = readRaw(file);
  const plugins = [];
  const ignored = [];
  for (const raw of data.plugins) {
    const entry = sanitizeEntry(raw);
    if (entry) plugins.push(entry);
    else ignored.push(describeIgnored(raw));
  }
  return { version: data.version, plugins, ignored };
}

function write(file, data) {
  ensureDir(path.dirname(file));
  const payload = { version: MANIFEST_VERSION, plugins: data.plugins || [] };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

const sortKey = (p) => (isPlainObject(p) ? `${p.repo}/${p.plugin}` : '');

function upsert(file, entry) {
  const data = readRaw(file);
  data.plugins = data.plugins.filter((p) => !matches(p, entry));
  data.plugins.push(entry);
  data.plugins.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return write(file, data);
}

function remove(file, { plugin, repo }) {
  const data = readRaw(file);
  const before = data.plugins.length;
  data.plugins = data.plugins.filter((p) => !matches(p, { plugin, repo }));
  write(file, data);
  return before - data.plugins.length;
}

const find = (file, { plugin, repo }) =>
  read(file).plugins.find((p) => (repo ? sameEntry(p, { plugin, repo }) : p.plugin === plugin)) ||
  null;

/**
 * The raw recorded entry, shape unchecked. uninstall reads recorded state -
 * the marketplace name, the target list to shrink - for entries the sanitized
 * view hides, so removing a row this build cannot fully read still works
 * offline and still updates the record.
 */
const findRaw = (file, { plugin, repo }) =>
  readRaw(file).plugins.find((p) => matches(p, { plugin, repo })) || null;

const list = (file) => read(file).plugins;

module.exports = { MANIFEST_VERSION, read, write, upsert, remove, find, findRaw, list, sameEntry };
