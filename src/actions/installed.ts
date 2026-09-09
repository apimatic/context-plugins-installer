import { resolveTargets } from '../application/target-selection.js';
import { NAMES } from '../types/harness.js';
import type { ManifestContext } from '../types/manifest-context.js';
import type { InstalledReport } from '../types/reports.js';
import { ActionResult } from './action-result.js';

export interface InstalledRequest {
  /** `--targets` as written, or null for "no filter asked for". */
  targets?: readonly string[] | null;
}

/**
 * What is recorded on this machine, filtered to the editors asked for. The only
 * I/O is the manifest read; everything else is the filter and what to call it.
 */
export class InstalledAction {
  constructor(private readonly manifest: ManifestContext) {}

  readonly execute = (req: InstalledRequest): ActionResult<InstalledReport> => {
    // Read before the flag is checked, so the report carries the gaps whichever
    // way the run goes - and so the order matches what it always was. Nothing
    // renders them on the failed arm: the command answers with the `Failure`
    // and stops, exactly as the throw here used to.
    const gaps = this.manifest.read();
    const nothing: InstalledReport = { entries: [], want: [], scoped: false, gaps };

    const want = resolveTargets(req.targets);
    if (!want.ok) return ActionResult.failed(nothing, want.error);

    // Filtering is unconditional because `resolveTargets` reads "nothing asked
    // for" as every editor, and `read()` never yields a row with no known
    // target - so an unfiltered run and `--targets all` take the same path.
    const entries = gaps.plugins.filter((e) => e.targets.some((t) => want.value.includes(t)));
    // Naming every editor adds nothing, so `all` reads as no scope at all.
    const scoped = want.value.length < NAMES.length;
    return ActionResult.success({ entries, want: want.value, scoped, gaps });
  };
}
