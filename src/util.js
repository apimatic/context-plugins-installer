'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * A problem the user can fix (bad plugin id, missing harness, network refusal).
 * The CLI prints these as a one-line message with no stack trace.
 */
class UserError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

// Plugin ids match the generator's contract: kebab-case, <= 64 chars.
const PLUGIN_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// These three values are interpolated into URLs and passed as argv, so they are
// validated at the edge rather than trusted from flags/env/rc files.
function assertPlugin(id) {
  if (typeof id !== 'string' || !PLUGIN_RE.test(id) || id.length > 64) {
    throw new UserError(`Invalid plugin id: ${JSON.stringify(id)}`, {
      hint: 'Expected kebab-case, e.g. acme-payments',
    });
  }
  return id;
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new UserError(`Invalid repo: ${JSON.stringify(repo)}`, {
      hint: 'Expected owner/repo, e.g. acme/plugin-marketplace',
    });
  }
  return repo;
}

function assertRef(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new UserError(`Invalid ref: ${JSON.stringify(ref)}`, {
      hint: 'Expected a branch, tag, or commit sha, e.g. main',
    });
  }
  return ref;
}

const isSha = (ref) => SHA_RE.test(ref);

// ---- filesystem ------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function exists(target) {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirNonEmpty(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Recursive copy. Written by hand so we never emit fs.cp's experimental warning. */
function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isSymbolicLink()) {
      // Symlinks need elevation on Windows; degrade to a plain copy rather than fail.
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch {
        try {
          fs.copyFileSync(from, to);
        } catch {
          /* unresolvable link - skip it */
        }
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Replace dest wholesale, so a shrinking plugin never leaves orphan files behind. */
function replaceDir(src, dest) {
  rmrf(dest);
  copyDir(src, dest);
  return dest;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

// ---- process ---------------------------------------------------------------

/** PATH lookup that honours PATHEXT, so we can spawn without shell: true. */
function which(cmd, env = process.env) {
  const raw = env.PATH || env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of raw.split(sep)) {
    if (!dir) continue;
    const clean = dir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const candidate = path.join(clean, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

const winQuote = (s) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Spawn and capture. Never uses `shell: true`.
 *
 * Windows note: Node refuses to spawn .cmd/.bat directly (CVE-2024-27980 hardening),
 * and npm-installed CLIs like `claude` land as .cmd shims - so those go through
 * cmd.exe with an explicitly quoted command line.
 */
function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdio = ['ignore', 'pipe', 'pipe'];
    let child;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      const line = [file, ...args].map(winQuote).join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        ...opts,
        stdio,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(file, args, { ...opts, stdio });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code == null ? 1 : code, stdout, stderr }));
  });
}

/** Bounded-concurrency map; keeps the API-fallback download from opening 200 sockets. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** yyyyMMdd-HHmmss, used as the settings.json backup suffix. */
function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Display form of a path: `~` beats repeating the user's home directory back at them. */
function shortPath(target, home = require('os').homedir()) {
  if (!target || !home) return target;
  const normalized = String(target);
  if (normalized.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = normalized.slice(home.length);
    return `~${rest.startsWith(path.sep) || rest.startsWith('/') ? '' : path.sep}${rest}`;
  }
  return normalized;
}

/** Edit distance, capped work for the short strings we compare (plugin ids). */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_v, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1];
}

const sharedPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/**
 * Closest names to `query`. Substring hits rank first, then names sharing a
 * substantial prefix - plugin ids in a marketplace tend to share a suffix, so
 * plain edit distance alone rates `azure-cognitve` as too far from
 * `azure-cognitive-sdk` to be worth offering.
 */
function suggest(query, candidates, limit = 3) {
  const q = String(query).toLowerCase();
  const threshold = Math.max(3, Math.ceil(q.length * 0.4));
  const scored = candidates
    .map((name) => {
      const n = String(name).toLowerCase();
      if (n.includes(q) || q.includes(n)) return { name, score: 0 };
      if (sharedPrefix(q, n) >= Math.max(4, Math.ceil(q.length * 0.6))) return { name, score: 1 };
      return { name, score: editDistance(q, n) };
    })
    .filter((c) => c.score <= threshold)
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map((c) => c.name);
}

module.exports = {
  UserError,
  assertPlugin,
  assertRepo,
  assertRef,
  isSha,
  ensureDir,
  rmrf,
  exists,
  isDirNonEmpty,
  copyDir,
  replaceDir,
  countFiles,
  which,
  run,
  pool,
  timestamp,
  stripBom,
  shortPath,
  editDistance,
  suggest,
};
