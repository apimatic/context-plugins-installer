import type { TelemetryLine } from '../types/telemetry.js';
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
