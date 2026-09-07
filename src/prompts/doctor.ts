import type { DoctorReport, DoctorStatus } from '../types/doctor.js';
import { log } from './terminal.js';

const SYMBOL: Record<DoctorStatus, string> = { ok: log.MARK, warn: '!', fail: 'x' };

/** Labels wider than this stop widening the column. */
const LABEL_CAP = 22;

export class DoctorPrompts {
  json(report: DoctorReport): void {
    log.payload(JSON.stringify(report, null, 2));
  }

  render(report: DoctorReport): void {
    const labels = report.groups.flatMap((g) => g.checks.map((c) => c.label.length));
    const width = Math.min(Math.max(...labels, 8), LABEL_CAP);
    for (const group of report.groups) {
      log.step(group.title);
      for (const c of group.checks) {
        // A passing check is dimmed: the eye should land on what needs doing.
        const paint = c.status === 'ok' ? log.dim : (s: string) => s;
        log.plain(`  ${SYMBOL[c.status]}   ${c.label.padEnd(width)}  ${paint(c.detail)}`);
        if (c.hint) log.info(c.hint);
      }
    }

    log.plain('');
    log.rule();
    if (report.failures) {
      log.error(`${log.plural(report.failures, 'problem')} found.`);
    } else if (report.warnings) {
      log.ok(`No problems. ${log.plural(report.warnings, 'warning')}.`);
    } else {
      log.ok('Everything checks out.');
    }
    log.plain('');
  }
}
