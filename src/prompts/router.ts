import type { Failure } from '../types/failure.js';
import type { MarketplaceListener } from '../types/session.js';
import type { TelemetryLine } from '../types/telemetry.js';
import { announceMarketplace } from './marketplace.js';
import { log } from './terminal.js';
import { printTelemetryLines } from './telemetry.js';

/**
 * Everything the router itself says, which is little: the version, the help,
 * a failure, and the one warning about a flag that does nothing here. The
 * terminal's own settings are set from here too, because `--verbose` and
 * `--quiet` are flags the router reads and nothing below it should have to.
 */
export class RouterPrompts {
  /**
   * Marketplace progress - the registry read, the clone, the marketplace add -
   * rendered by the one function that owns those words. It hangs off the
   * prompts class rather than being imported at the call site so that
   * everything the router says is reachable from here.
   */
  readonly marketplaceListener: MarketplaceListener = announceMarketplace;

  configure(flags: { verbose?: boolean; quiet?: boolean }): void {
    log.setVerbose(flags.verbose);
    log.setQuiet(flags.quiet);
  }

  version(version: string): void {
    log.plain(version);
  }

  help(text: string): void {
    log.plain(text);
  }

  /**
   * A failure with a sentence and a hint: what went wrong, then what to do
   * about it. The hint goes to stdout with the message, where it has always
   * been - it is part of the answer, not a diagnostic.
   */
  failure(failure: Failure): void {
    log.error(failure.message);
    if (failure.hint) log.info(failure.hint);
  }

  /**
   * A throw that reached the top is a bug in this program, so it says what it
   * can and keeps the stack for `--verbose` - a stack trace is the right answer
   * to "this should not have happened" and the wrong one to everything else.
   */
  crash(message: string, stack?: string): void {
    log.error(message);
    if (log.isVerbose && stack) log.plain(stack);
  }

  /**
   * Silently ignoring it is how `installed --targets vscode` came to answer as
   * though the flag were absent. On stderr, so a `--json` payload stays clean.
   */
  targetsIgnored(command: string): void {
    log.warnStderr(`--targets does nothing for \`${command}\` - ignoring it.`);
  }

  /**
   * A diagnostic, for `--verbose` only. The sink hands its own failures here:
   * whether anyone hears about a reporting problem is the terminal's business
   * and not the sender's.
   */
  debug(message: string): void {
    log.debug(message);
  }

  /**
   * What telemetry would have said, once it has flushed. The sender never
   * prints: it hands back its lines, in order, and this puts them on the
   * terminal - which is also where the one-time notice becomes remembered.
   */
  flushed(lines: readonly TelemetryLine[]): void {
    printTelemetryLines(lines);
  }
}
