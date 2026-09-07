import { ClaudeHarness } from '../harnesses/claude.js';
import { CursorHarness } from '../harnesses/cursor.js';
import { VscodeHarness } from '../harnesses/vscode.js';
import { NAMES, type Harness, type HarnessName } from '../types/harness.js';

// The editors this build can install into. The names and titles are static
// knowledge and live in types/harness.ts; this is only the mapping from one to
// the other, so a pure decision can name an editor without reaching for the
// code that installs into it.
//
// Mid-move: every editor is a silent class under src/harnesses/ now, so the
// next commit moves this registry there as HarnessRegistry.

const BY_NAME: Record<HarnessName, Harness> = {
  claude: new ClaudeHarness(),
  cursor: new CursorHarness(),
  vscode: new VscodeHarness(),
};

/** Total over HarnessName; narrow a string with isHarnessName first. */
export const byName = (name: HarnessName): Harness => BY_NAME[name];

export const HARNESSES: readonly Harness[] = NAMES.map(byName);
