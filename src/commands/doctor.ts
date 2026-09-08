import type { ActionResult } from '../actions/action-result.js';
import { DoctorAction, type DoctorRequest } from '../actions/doctor.js';
import { DoctorPrompts } from '../prompts/doctor.js';
import type { DoctorReport } from '../types/doctor.js';
import type { MachineServices } from '../types/services.js';

export interface DoctorArgs extends DoctorRequest {
  json?: boolean;
}

/**
 * `doctor` never fails on its own account - every check answers - so the exit
 * code comes from what the checks found and there is no error line to add.
 */
export class DoctorCommand {
  constructor(
    private readonly services: MachineServices,
    private readonly prompts = new DoctorPrompts(),
  ) {}

  async run(args: DoctorArgs): Promise<ActionResult<DoctorReport>> {
    const { services } = this;
    const env = services.env();
    const result = await new DoctorAction(
      services.registry(),
      services.runner(env),
      { fetch, env },
      this.prompts.marketplaceListener,
      args.pathOpts,
    ).execute(args.brand);
    if (args.json) this.prompts.json(result.report);
    else this.prompts.render(result.report);
    return result;
  }
}
