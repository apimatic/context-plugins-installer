import { NAMES, isHarnessName, type Harness, type HarnessName } from '../types/harness.js';
import { UserError } from '../util.js';
import * as claude from './claude.js';
import * as cursor from './cursor.js';
import * as vscode from './vscode.js';

// The editors this build can install into, as modules. The names and titles are
// static knowledge and live in types/harness.ts; this is only the mapping from
// one to the other, so a pure decision can name an editor without reaching for
// the code that installs into it.

const BY_NAME: Record<HarnessName, Harness> = { claude, cursor, vscode };

/** Total over HarnessName; narrow a string with isHarnessName first. */
export const byName = (name: HarnessName): Harness => BY_NAME[name];

export const HARNESSES: readonly Harness[] = NAMES.map(byName);

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
