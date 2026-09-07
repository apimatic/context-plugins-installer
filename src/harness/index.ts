import { CursorHarness } from '../harnesses/cursor.js';
import { NAMES, type Harness, type HarnessName } from '../types/harness.js';
import * as claude from './claude.js';
import * as vscode from './vscode.js';

// The editors this build can install into. The names and titles are static
// knowledge and live in types/harness.ts; this is only the mapping from one to
// the other, so a pure decision can name an editor without reaching for the
// code that installs into it.
//
// Mid-move: each editor becomes a silent class under src/harnesses/ in its own
// commit, and this registry becomes HarnessRegistry there once the last one has
// gone. The two still here print through src/log.ts, which is why they cannot
// sit in that directory yet - eslint refuses it.

const BY_NAME: Record<HarnessName, Harness> = { claude, cursor: new CursorHarness(), vscode };

/** Total over HarnessName; narrow a string with isHarnessName first. */
export const byName = (name: HarnessName): Harness => BY_NAME[name];

export const HARNESSES: readonly Harness[] = NAMES.map(byName);
