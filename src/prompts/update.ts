import { titlesOf, type HarnessName } from '../types/harness.js';
import { log } from './terminal.js';
import { InstallPrompts } from './install.js';

/** A plugin id longer than this stops widening the column. */
const ID_WIDTH_CAP = 42;

export class UpdatePrompts {
  /** Set once the rows are known, so every line in the grid lines up. */
  private width = 4;

  constructor(private readonly home?: string) {}

  /**
   * One line per plugin rather than a full install report each. Off under
   * `--verbose` (which asked for the detail) and under `--quiet` (which asked
   * for none), so the grid is only for the ordinary run.
   */
  readonly collapse = !log.isVerbose && !log.isQuiet;

  /** The prompts each row's install reports through. */
  installPrompts(): InstallPrompts {
    return new InstallPrompts(this.home);
  }

  /**
   * Runs one row with the rest of the run silenced, so only the grid line
   * survives. `log.setQuiet` and not a muted `InstallPrompts`, because what has
   * to go quiet includes the harnesses and the session's marketplace lines -
   * neither of which the install prompts own.
   */
  async collapsed<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.collapse) return fn();
    log.setQuiet(true);
    try {
      return await fn();
    } finally {
      log.setQuiet(false);
    }
  }

  nothingToUpdate(): void {
    log.warn('No plugins installed yet - nothing to update.');
  }

  intro(rows: number, names: readonly string[]): void {
    this.width = Math.min(Math.max(...names.map((n) => n.length), 4), ID_WIDTH_CAP);
    log.banner(`Updating ${log.plural(rows, 'plugin')}`);
    log.plain('');
  }

  private cell(plugin: string): string {
    return plugin.padEnd(this.width);
  }

  /** A row this build cannot read at all: a failure, and it says why. */
  unreadable(plugin: string, reason: string): void {
    log.error(`${this.cell(plugin)}  cannot update - ${reason}`);
  }

  /**
   * Not a failure: the row updates for the targets this build knows, and the
   * ones it does not are written back untouched.
   */
  unknownTargets(plugin: string, targets: readonly string[]): void {
    log.warn(`${this.cell(plugin)}  not updating unknown target(s): ${targets.join(', ')}`);
  }

  /**
   * Nowhere to refresh it: a skip, not the failure that would make `update`
   * exit 1 on this row forever.
   */
  noEditor(plugin: string): void {
    log.warn(`${this.cell(plugin)}  no editor for it on this machine - skipping`);
  }

  /**
   * The row's source is not there to refresh from. A warning rather than a
   * failure, and it names both ways out, because this is what a moved dev
   * folder looks like and neither of them is obvious from the row alone.
   */
  unavailable(plugin: string, reason: string): void {
    log.warn(`${this.cell(plugin)}  ${reason} - install it again, or uninstall it`);
  }

  /**
   * The source now calls its plugin something else. The new name is installed
   * and recorded; the old copy is still on disk and still loaded, and only the
   * user can say whether that is one plugin renamed or two that share a
   * folder - so this names the way out rather than guessing.
   */
  renamed(was: string, now: string): void {
    log.warn(
      `${this.cell(was)}  now calls itself '${now}' - the copy under the old name is still installed (uninstall '${was}')`,
    );
  }

  updated(plugin: string, targets: readonly HarnessName[]): void {
    if (this.collapse) log.ok(`${this.cell(plugin)}  ${log.dim(titlesOf(targets))}`);
  }

  rowFailed(plugin: string, error: string): void {
    log.error(`${this.cell(plugin)}  ${error}`);
  }

  summary(updated: number, rows: number, failed: readonly { plugin: string }[]): void {
    log.plain('');
    log.rule();
    if (failed.length) {
      log.warn(`Updated ${updated} of ${rows}; failed: ${failed.map((f) => f.plugin).join(', ')}`);
    } else {
      log.ok(`Updated ${log.plural(updated, 'plugin')}`);
    }
    log.plain('');
  }
}
