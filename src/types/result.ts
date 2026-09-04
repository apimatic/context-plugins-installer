import type { Failure } from './failure.js';

/**
 * The outcome of work that can fail for a reason the caller must handle.
 * Discriminated on `ok`, so a check narrows the value without a cast.
 */
export type Result<T, E = Failure> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
