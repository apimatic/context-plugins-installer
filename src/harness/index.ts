import type { Harness, HarnessName } from '../types/harness.js';
import { UserError } from '../util.js';
import * as claude from './claude.js';
import * as cursor from './cursor.js';
import * as vscode from './vscode.js';

export const HARNESSES: readonly Harness[] = [claude, cursor, vscode];
export const NAMES: readonly HarnessName[] = HARNESSES.map((h) => h.name);

/** Editor titles in the order `NAMES` gives, for any prose that lists them. */
export const titlesOf = (names: readonly HarnessName[], sep = ', '): string =>
  names.map((n) => byName(n).title).join(sep);

/**
 * Every editor this build knows, in prose. Derived from `NAMES` on purpose:
 * these lists are the one thing the compiler cannot keep honest when a harness
 * is added, so there is nothing here to forget to update. Pass a conjunction
 * for "a, b, or c"; omit it for the "a / b / c" form.
 */
export function everyEditor(conjunction?: string): string {
  if (!conjunction || NAMES.length < 2) return titlesOf(NAMES, ' / ');
  const last = byName(NAMES[NAMES.length - 1]).title;
  const head = NAMES.slice(0, -1);
  return `${titlesOf(head)}${head.length > 1 ? ',' : ''} ${conjunction} ${last}`;
}

const BY_NAME: Record<HarnessName, Harness> = { claude, cursor, vscode };

export const isHarnessName = (name: unknown): name is HarnessName =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(BY_NAME, name);

/** Total over HarnessName; narrow a string with isHarnessName first. */
export const byName = (name: HarnessName): Harness => BY_NAME[name];

export function resolveTargets(requested?: readonly string[] | null): HarnessName[] {
  if (!requested || requested.length === 0 || requested.includes('all')) return [...NAMES];
  const unknown = requested.filter((t) => !isHarnessName(t));
  if (unknown.length) {
    throw new UserError(`Unknown target(s): ${unknown.join(', ')}`, {
      hint: `Valid targets: ${NAMES.join(', ')}, all`,
    });
  }
  return NAMES.filter((n) => requested.includes(n)); // canonical order
}

export { claude, cursor, vscode };
