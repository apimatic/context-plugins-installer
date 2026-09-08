import type { ActionResult } from '../actions/action-result.js';
import { DoctorAction, type DoctorRequest } from '../actions/doctor.js';
import { DoctorPrompts } from '../prompts/doctor.js';
import type { DoctorReport } from '../types/doctor.js';

export interface DoctorArgs extends DoctorRequest {
  json?: boolean;
}

/**
 * `doctor` never fails on its own account - every check answers - so the exit
 * code comes from what the checks found and there is no error line to add.
 */
export class DoctorCommand {
  constructor(private readonly prompts = new DoctorPrompts()) {}

  async run(args: DoctorArgs): Promise<ActionResult<DoctorReport>> {
    const result = await new DoctorAction(
      this.prompts.marketplaceListener,
      args.deps,
      args.pathOpts,
    ).execute(args.brand);
    if (args.json) this.prompts.json(result.report);
    else this.prompts.render(result.report);
    return result;
  }
}
