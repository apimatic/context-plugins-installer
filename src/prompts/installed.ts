import { BIN } from '../types/brand.js';
import { titlesOf } from '../types/harness.js';
import type { ManifestEntry } from '../types/installed-record.js';
import { localDirOf } from '../types/plugin-source.js';
import type { InstalledReport } from '../types/reports.js';
import { gapWarnings } from './gaps.js';
import { log } from './terminal.js';

/** A plugin id longer than this stops widening the column. */
const ID_WIDTH_CAP = 42;

export class InstalledPrompts {
  /**
   * Where a row came from, under `--verbose`: a repository and its ref, or the
   * directory it was installed from - which has neither, so printing
   * `<repo>@<ref>` for one would read as `local:/x@undefined`.
   */
  private origin(e: ManifestEntry): string {
    const dir = localDirOf(e.repo);
    const from = dir === null ? `${e.repo}@${e.ref}` : dir;
    return `${from}  (marketplace: ${e.marketplace})`;
  }

  /** ` in Cursor`, or nothing when every editor is in scope. */
  private scope(report: InstalledReport): string {
    return report.scoped ? ` in ${titlesOf(report.want)}` : '';
  }

  private gaps(report: InstalledReport, emit: (msg: string) => void): void {
    for (const msg of gapWarnings(report.gaps)) emit(msg);
  }

  /**
   * Schema stability: the payload stays the plain entry array, so what it cannot
   * represent is reported on stderr instead - where a tool reading stdout will
   * not trip over it.
   */
  json(report: InstalledReport): void {
    this.gaps(report, log.warnStderr);
    log.payload(JSON.stringify(report.entries, null, 2));
  }

  render(report: InstalledReport): void {
    if (!report.entries.length) {
      this.gaps(report, log.warn);
      const scope = this.scope(report);
      log.info(scope ? `No plugins installed${scope}.` : 'No plugins installed yet.');
      log.info(`Browse what is available with:  ${BIN} list`);
      return;
    }
    log.banner(`${log.plural(report.entries.length, 'plugin')} installed${this.scope(report)}`);
    log.plain('');
    const width = Math.min(
      Math.max(...report.entries.map((e) => e.plugin.length), 4),
      ID_WIDTH_CAP,
    );
    for (const e of report.entries) {
      log.plain(`    ${e.plugin.padEnd(width)}  ${log.dim(titlesOf(e.targets))}`);
      log.debug(this.origin(e));
    }
    this.gaps(report, log.warn);
    log.plain('');
  }
}
