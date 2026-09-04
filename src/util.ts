import type { Failure } from './types/failure.js';
import { GitRef } from './types/ids/git-ref.js';
import { PluginId } from './types/ids/plugin-id.js';
import { RepoSlug } from './types/ids/repo-slug.js';
import type { Result } from './types/result.js';

/** A problem the user can fix; the CLI prints it as one line with no stack trace. */
export class UserError extends Error {
  hint: string | undefined;

  constructor(message: string, { hint }: { hint?: string } = {}) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The values an environment switch uses to mean "no". */
export const ENV_OFF: ReadonlySet<string> = new Set(['0', 'off', 'false', 'no']);

/** Set to anything but an explicit "no": `CI=1`, `CI=true` and `DO_NOT_TRACK=1` all count. */
export const envFlag = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && !ENV_OFF.has(value.toLowerCase());

// Each identifier's rule now lives with its type. These three are the throwing
// edge their callers still expect: a plugin id, a repo and a ref are all
// interpolated into URLs and passed as argv, so they are refused where they
// enter rather than trusted from a flag, an env var, or an rc file. Phase 2
// reads the Result itself and takes this helper with the last of them.
/**
 * The bridge between a Result and the throw its callers still expect. Every
 * conversion of a module to Results leaves one of these at its caller until the
 * caller is converted too, and then it goes.
 */
export function orThrow<T>(parsed: Result<T, Failure>): T {
  if (!parsed.ok) throw new UserError(parsed.error.message, { hint: parsed.error.hint });
  return parsed.value;
}

export const assertPlugin = (id: unknown): string => orThrow(PluginId.parse(id)).toString();

export const assertRepo = (repo: unknown): string => orThrow(RepoSlug.parse(repo)).toString();

export const assertRef = (ref: unknown): string => orThrow(GitRef.parse(ref)).toString();

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const errorCode = (err: unknown): unknown =>
  err instanceof Error && 'code' in err ? err.code : undefined;

/** yyyyMMdd-HHmmss */
export function timestamp(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

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
