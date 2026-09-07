import type { ActionResult } from '../actions/action-result.js';
import { TelemetryAction, type TelemetryRequest } from '../actions/telemetry.js';
import { TelemetryPrompts } from '../prompts/telemetry.js';
import type { TelemetrySettings } from '../types/ports.js';
import type { TelemetryReport } from '../types/reports.js';

/**
 * `telemetry` says the same four lines whichever way it was called, plus one
 * about what just changed - so the command renders and the action decides.
 */
export class TelemetryCommand {
  constructor(private readonly prompts = new TelemetryPrompts()) {}

  run(req: TelemetryRequest, settings: TelemetrySettings): ActionResult<TelemetryReport> {
    const result = new TelemetryAction(settings).execute(req);
    const { verb, status, overridden, writeError } = result.report;
    if (writeError) this.prompts.writeFailed(writeError);
    if (!verb || !status) return result;
    if (verb !== 'status') this.prompts.saved(verb);
    this.prompts.status(status, verb, overridden);
    return result;
  }
}
