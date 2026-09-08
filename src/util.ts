// The pure helpers, and nothing else. There is no error class here any more and
// no bridge that makes one: a problem the user can fix is a `Failure` on the
// failed arm of an `ActionResult`, which the router prints and telemetry counts
// as `user`. A throw that reaches the top is a bug, reported as `unexpected`,
// and the only thing that prints a stack.

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The values an environment switch uses to mean "no". */
export const ENV_OFF: ReadonlySet<string> = new Set(['0', 'off', 'false', 'no']);

/** Set to anything but an explicit "no": `CI=1`, `CI=true` and `DO_NOT_TRACK=1` all count. */
export const envFlag = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && !ENV_OFF.has(value.toLowerCase());

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
