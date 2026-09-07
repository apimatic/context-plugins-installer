import { InstalledAction, type InstalledRequest } from '../actions/installed.js';
import type { ActionResult } from '../actions/action-result.js';
import { InstalledPrompts } from '../prompts/installed.js';
import type { ManifestContext } from '../types/manifest-context.js';
import type { InstalledReport } from '../types/reports.js';

export interface InstalledArgs extends InstalledRequest {
  json?: boolean;
}

/**
 * `installed` has no progress to report - the whole of its output is the answer
 * - so the command renders the report the action hands back and nothing is said
 * while the work happens.
 */
export class InstalledCommand {
  constructor(private readonly prompts = new InstalledPrompts()) {}

  run(args: InstalledArgs, manifest: ManifestContext): ActionResult<InstalledReport> {
    const result = new InstalledAction(manifest).execute(args);
    if (result.isFailed()) return result;
    if (args.json) this.prompts.json(result.report);
    else this.prompts.render(result.report);
    return result;
  }
}
