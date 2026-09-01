import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';

import type { Env, RunResult } from './types.js';

/** A problem the user can fix; the CLI prints it as one line with no stack trace. */
export class UserError extends Error {
  hint: string | undefined;

  constructor(message: string, { hint }: { hint?: string } = {}) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

const PLUGIN_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

// These three are interpolated into URLs and passed as argv, so they are
// validated at the edge rather than trusted from flags, env, or rc files.
export function assertPlugin(id: unknown): string {
  if (typeof id !== 'string' || !PLUGIN_RE.test(id) || id.length > 64) {
    throw new UserError(`Invalid plugin id: ${JSON.stringify(id)}`, {
      hint: 'Expected kebab-case, e.g. acme-payments',
    });
  }
  return id;
}

export function assertRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new UserError(`Invalid repo: ${JSON.stringify(repo)}`, {
      hint: 'Expected owner/repo, e.g. acme/plugin-marketplace',
    });
  }
  return repo;
}

export function assertRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new UserError(`Invalid ref: ${JSON.stringify(ref)}`, {
      hint: 'Expected a branch, tag, or commit sha, e.g. main',
    });
  }
  return ref;
}

export const isSha = (ref: string): boolean => SHA_RE.test(ref);

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const errorCode = (err: unknown): unknown =>
  err instanceof Error && 'code' in err ? err.code : undefined;

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

export function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDirNonEmpty(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Hand-written so it never emits fs.cp's experimental warning.
export function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isSymbolicLink()) {
      // Symlinks need elevation on Windows; degrade to a plain copy.
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch {
        try {
          fs.copyFileSync(from, to);
        } catch {
          /* unresolvable link */
        }
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Wholesale replace, so a shrinking plugin leaves no orphan files behind. */
export function replaceDir(src: string, dest: string): string {
  rmrf(dest);
  copyDir(src, dest);
  return dest;
}

export function countFiles(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

/** PATH lookup that honours PATHEXT, so spawning never needs shell: true. */
export function which(cmd: string, env: Env = process.env): string | null {
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

const winQuote = (s: string): string => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// Node refuses to spawn .cmd/.bat directly (CVE-2024-27980), and npm-installed
// CLIs land as .cmd shims on Windows, so those go through cmd.exe with an
// explicitly quoted command line.
export function run(file: string, args: string[], opts: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdio: StdioOptions = ['ignore', 'pipe', 'pipe'];
    let child: ChildProcess;
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
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d;
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code: number | null) =>
      resolve({ code: code == null ? 1 : code, stdout, stderr }),
    );
  });
}

/** Bounded-concurrency map, in input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** yyyyMMdd-HHmmss */
export function timestamp(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function shortPath(target: string, home: string = os.homedir()): string {
  if (!target || !home) return target;
  const normalized = String(target);
  if (normalized.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = normalized.slice(home.length);
    return `~${rest.startsWith(path.sep) || rest.startsWith('/') ? '' : path.sep}${rest}`;
  }
  return normalized;
}

export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev: number[] = Array.from({ length: cols }, (_v, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j < cols; j += 1) {
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1] as number;
}

const sharedPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

// Substring and shared-prefix hits rank before edit distance: plugin ids share
// suffixes like `-sdk`, which makes a near miss look far away.
export function suggest(query: string, candidates: readonly string[], limit = 3): string[] {
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
