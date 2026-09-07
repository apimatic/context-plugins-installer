import { BIN } from '../types/brand.js';
import type { Failure } from '../types/failure.js';
import {
  COLLECTED,
  type TelemetryLine,
  type TelemetryStatus,
  type TelemetryVerb,
} from '../types/telemetry.js';
import { format as f } from './format.js';
import { log } from './terminal.js';

// Keyed by the union rather than an if/else, so adding a kind is a type error
// here instead of falling through to `notice` - which ignores --quiet by design.
const WRITERS: Record<TelemetryLine['kind'], (line: TelemetryLine) => void> = {
  debug: (line) => log.debug(line.text),
  notice: (line) => log.notice(line.text, { verbatim: line.verbatim }),
};

/**
 * The one place a telemetry line reaches a terminal. The sender returns its
 * lines rather than printing them, and this renders them in the order they were
 * produced, telling each one it has been shown.
 */
export function printTelemetryLines(lines: readonly TelemetryLine[]): void {
  for (const line of lines) {
    WRITERS[line.kind](line);
    line.onShown?.();
  }
}

/**
 * Telemetry as one phrase, for `telemetry status` and for `doctor`. `enabled`
 * and the two `CP_TELEMETRY` modes are what the run is doing; everything else
 * names the switch that turned it off, because "disabled" alone leaves a user
 * hunting for which of five places did it.
 */
export function describeTelemetry(status: TelemetryStatus, bin: string): string {
  if (status.mode === 'on') return 'enabled';
  if (status.mode === 'log') return 'log only (CP_TELEMETRY=log)';
  switch (status.optOut) {
    case 'rc':
      return 'disabled (.contextpluginsrc)';
    case 'state':
      return 'disabled (telemetry.json could not be read)';
    case 'user':
      return `disabled (${bin} telemetry disable)`;
    default:
      return `disabled (${status.optOut ?? 'unknown'})`;
  }
}

export class TelemetryPrompts {
  /** The service's own reason for a failed write, kept for `--verbose`. */
  writeFailed(error: Failure): void {
    log.debug(error.message);
  }

  saved(verb: 'enable' | 'disable'): void {
    log.ok(`Telemetry ${verb === 'enable' ? 'enabled' : 'disabled'}.`);
  }

  status(status: TelemetryStatus, verb: TelemetryVerb, overridden: boolean): void {
    const effective = describeTelemetry(status, BIN);
    if (verb === 'status') log.plain(`Telemetry is ${effective}.`);
    else if (overridden) log.info(`Right now it is ${effective}; that setting takes precedence.`);
    if (status.id) log.info(`Anonymous machine id: ${status.id} (${f.path(status.file)})`);
    log.info(`Collected: ${COLLECTED}.`);
    log.info(
      `Change it with '${BIN} telemetry enable|disable', CP_TELEMETRY=off, or DO_NOT_TRACK=1.`,
    );
  }
}
