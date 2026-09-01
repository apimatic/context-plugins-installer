import type { Harness, HarnessName } from '../types.js';
import { UserError } from '../util.js';
import * as claude from './claude.js';
import * as cursor from './cursor.js';
import * as vscode from './vscode.js';

export const HARNESSES: readonly Harness[] = [claude, cursor, vscode];
export const NAMES: readonly HarnessName[] = HARNESSES.map((h) => h.name);

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
