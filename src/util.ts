import type { Failure } from './types/failure.js';
import { PluginId } from './types/ids/plugin-id.js';
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

/**
 * The bridge between a Result and the throw its callers still expect. Every
 * conversion of a module to Results leaves one of these at its caller until the
 * caller is converted too, and then it goes. Phase 5 removes the last one.
 */
export function orThrow<T>(parsed: Result<T, Failure>): T {
  if (!parsed.ok) throw new UserError(parsed.error.message, { hint: parsed.error.hint });
  return parsed.value;
}

// Each identifier's rule lives with its type. This is the throwing edge the
// install and uninstall flows still expect: a plugin id is interpolated into
// argv, so it is refused where it enters rather than trusted from a flag or an
// env var. The repo and ref wrappers went when brand resolution started reading
// the Result itself; this one goes with `orThrow`.
export const assertPlugin = (id: unknown): string => orThrow(PluginId.parse(id)).toString();

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
