import { BIN } from '../types/brand.js';
import { titlesOf } from '../types/harness.js';
import type { ListReport, ListedPlugin } from '../types/reports.js';
import type { MarketplaceListener } from '../types/session.js';
import { gapWarnings } from './gaps.js';
import { announceMarketplace } from './marketplace.js';
import { log } from './terminal.js';

/** A plugin id longer than this is ignored when sizing the grid. */
const OUTLIER_NAME = 36;

export class ListPrompts {
  /**
   * Marketplace progress - the registry read, the clone, the marketplace add -
   * rendered by the one function that owns those words. It hangs off the
   * prompts class rather than being imported at the call site so that
   * everything `list` says is reachable from here.
   */
  readonly marketplaceListener: MarketplaceListener = announceMarketplace;

  private warnings(report: ListReport): string[] {
    // Scoped to the marketplace being listed: another one's rows are not this
    // listing's business, which is why both gap kinds carry a repo.
    return gapWarnings(report.gaps, report.result.repo);
  }

  json(report: ListReport): void {
    for (const msg of this.warnings(report)) log.warnStderr(msg);
    log.payload(JSON.stringify(report.result, null, 2));
  }

  private long(plugins: readonly ListedPlugin[]): void {
    for (const p of plugins) {
      const mark = p.installed ? log.MARK : ' ';
      log.plain(`  ${mark} ${log.bold(p.name)}`);
      if (p.description) log.info(p.description);
      if (p.targets.length) {
        log.info(`Installed into: ${titlesOf(p.targets)}`);
      }
    }
  }

  private grid(plugins: readonly ListedPlugin[]): void {
    // A grid sized to the longest non-outlier name: one very long id would
    // otherwise set the width for every column and collapse the grid.
    const lengths = plugins.map((p) => p.name.length);
    const cell = Math.max(16, ...lengths.filter((l) => l <= OUTLIER_NAME)) + 3;
    const cols = Math.max(1, Math.floor((log.width(120) - 2) / cell));
    const rows = Math.ceil(plugins.length / cols);
    for (let r = 0; r < rows; r += 1) {
      let line = '  ';
      for (let c = 0; c < cols; c += 1) {
        const p = plugins[c * rows + r]; // column-major keeps A-Z reading down
        if (!p) continue;
        line += `${p.installed ? log.MARK : ' '} ${p.name.padEnd(cell - 2)}`;
      }
      log.plain(line.trimEnd());
    }
  }

  render(report: ListReport, long?: boolean): void {
    const plugins = [...report.result.plugins].sort((a, b) => a.name.localeCompare(b.name));
    log.banner(`${log.plural(plugins.length, 'plugin')} in ${report.result.label}`);
    log.plain('');

    if (long) this.long(plugins);
    else this.grid(plugins);

    log.plain('');
    const count = plugins.filter((p) => p.installed).length;
    if (count) {
      log.info(`${log.MARK} installed on this machine (${count})`);
    }
    for (const msg of this.warnings(report)) log.warn(msg);
    if (!long) log.info(`Run \`${BIN} list --long\` for descriptions.`);
    log.info(`Install one with \`${BIN} install <plugin>\`.`);
  }
}
