import { BIN } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import type { TelemetrySettings } from '../types/ports.js';
import type { TelemetryReport } from '../types/reports.js';
import { asTelemetryVerb } from '../types/telemetry.js';
import { format as f } from '../prompts/format.js';
import { ActionResult } from './action-result.js';

export interface TelemetryRequest {
  /** The sub-command as written, or undefined for `status`. */
  action?: string;
}

/** Refused before anything was read, so there is nothing to report about. */
const NOTHING: TelemetryReport = {
  verb: null,
  status: null,
  overridden: false,
  writeError: null,
};

/**
 * `telemetry status|enable|disable`. Reading the state is what `status` is, and
 * the two that write read it back afterwards - because saving a choice does not
 * make it the effective one: `DO_NOT_TRACK`, `CP_TELEMETRY` and either rc file
 * all take precedence, and the run has to be able to say so.
 */
export class TelemetryAction {
  constructor(private readonly settings: TelemetrySettings) {}

  readonly execute = (req: TelemetryRequest): ActionResult<TelemetryReport> => {
    const verb = asTelemetryVerb(req.action);
    if (!verb) {
      return ActionResult.failed(
        NOTHING,
        new Failure(
          `Unknown telemetry action: ${req.action}`,
          `Usage: ${BIN} telemetry [status|enable|disable]`,
        ),
      );
    }

    if (verb === 'status') {
      return ActionResult.success({ ...NOTHING, verb, status: this.settings.status() });
    }

    const enabled = verb === 'enable';
    const written = this.settings.setEnabled(enabled);
    if (!written.ok) {
      // The service's own message names the file and the reason; this says what
      // to do about it, and carries the original for `--verbose`.
      return ActionResult.failed(
        { ...NOTHING, verb, writeError: written.error },
        new Failure(
          `Could not write ${f.path(this.settings.file)}.`,
          enabled
            ? 'Check the permissions on the state directory, or point CP_STATE_DIR somewhere writable.'
            : 'CP_TELEMETRY=off in the environment needs no file.',
        ),
      );
    }

    const status = this.settings.status();
    return ActionResult.success({
      ...NOTHING,
      verb,
      status,
      overridden: status.mode !== (enabled ? 'on' : 'off'),
    });
  };
}
