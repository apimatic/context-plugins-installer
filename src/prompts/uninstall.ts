import type { Brand } from '../types/brand.js';
import type { Failure } from '../types/failure.js';
import { titlesOf, type HarnessListener, type HarnessName } from '../types/harness.js';
import type { MarketplaceListener } from '../types/session.js';
import type { SummaryLine } from '../types/uninstall.js';
import { harnessListener } from './harness/index.js';
import { announceMarketplace } from './marketplace.js';
import { log } from './terminal.js';

export class UninstallPrompts {
  constructor(private readonly home?: string) {}

  /** The harnesses report events; this is where they become lines. */
  readonly harnessListener: HarnessListener = (event) => harnessListener(this.home)(event);

  readonly marketplaceListener: MarketplaceListener = announceMarketplace;

  intro(plugin: string, brand: Brand, want: readonly HarnessName[]): void {
    log.banner(`Uninstalling '${plugin}' from ${brand.label}`);
    log.info(`Removing from: ${titlesOf(want)}`);
    log.rule();
  }

  beginHarness(title: string): void {
    log.step(`[${title}]`);
  }

  /**
   * A lookup that failed with a row to correct: a warning, not a refusal, so
   * `--force` still works offline and after an upstream rename.
   */
  marketplaceUnknown(plugin: string, error: Failure): void {
    log.warn(`Could not look up the marketplace for '${plugin}' - continuing. ${error.message}`);
  }

  /**
   * The plugin is out of every editor and off the record, but the copy this
   * tool staged for Claude Code is still there. Said rather than swallowed:
   * unmentioned it survives, and it is not a reason to fail a clean uninstall.
   */
  stagingLeft(error: Failure): void {
    log.warn(`${error.message} You can remove that directory by hand.`);
  }

  harnessThrew(title: string, message: string): void {
    log.warn(`${title}: ${message}`);
  }

  /**
   * One line per thing that happened and nothing that did not - which is why
   * the lines come from the decision rather than from anything here. Nothing to
   * say means a failure the caller reports, so there is no empty framing.
   */
  summary(lines: readonly SummaryLine[]): void {
    if (!lines.length) return;
    log.plain('');
    log.rule();
    for (const line of lines) log[line.level](line.text);
    log.plain('');
  }
}
