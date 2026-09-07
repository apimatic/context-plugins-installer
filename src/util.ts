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
