import { NAMES, type Harness, type HarnessName, type HarnessOpts } from '../types/harness.js';
import { ClaudeHarness } from './claude.js';
import { CursorHarness } from './cursor.js';
import { VscodeHarness } from './vscode.js';

// The editors this build can install into, as instances. The names and titles
// are static knowledge and live in types/harness.ts; this is only the mapping
// from one to the other, so a pure decision can name an editor without reaching
// for the code that installs into it - and a caller that only wants a title
// should read `TITLES` rather than come here for one.

export class HarnessRegistry {
  constructor(private readonly harnesses: Readonly<Record<HarnessName, Harness>>) {}

  /** Total over HarnessName; narrow a string with isHarnessName first. */
  byName(name: HarnessName): Harness {
    return this.harnesses[name];
  }

  /** Every editor, in the one order everything lists them in. */
  all(): readonly Harness[] {
    return NAMES.map((name) => this.byName(name));
  }

  /**
   * Which of `names` are installed on this machine, in the order given. Both
   * callers hand it a list that is already in canonical order - `resolveTargets`
   * sorts one, a manifest row is written in that order - so this reorders
   * nothing; it just has no business being the thing that decides.
   */
  detected(names: readonly HarnessName[], opts?: HarnessOpts): HarnessName[] {
    return names.filter((name) => this.byName(name).detect(opts));
  }
}

/**
 * The one registry, until Phase 6's composition root builds it with the
 * services each harness takes.
 */
export const harnesses = new HarnessRegistry({
  claude: new ClaudeHarness(),
  cursor: new CursorHarness(),
  vscode: new VscodeHarness(),
});
