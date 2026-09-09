import type { HarnessName, UninstallOutcome } from './harness.js';
import type { RowShape } from './installed-record.js';

// What an uninstall run established, and what it decided to do about it. The
// facts go in, the decision comes out, and both the record write and every line
// of the summary are read off that one decision - so the file and the prose can
// never disagree about what happened.

/** Everything the record and the summary are derived from. */
export interface UninstallFacts {
  /** The raw recorded row, exactly as it is on disk, or null for no row. */
  recorded: Record<string, unknown> | null;
  /** What each editor this run asked answered. */
  outcomes: ReadonlyMap<HarnessName, UninstallOutcome>;
  /** The editors this run asked. */
  want: readonly HarnessName[];
  force: boolean;
}

export interface UninstallDecision {
  /** Editors something was actually removed from. */
  removed: HarnessName[];
  /** Editors that were asked and went wrong. Non-empty means the run failed. */
  failed: HarnessName[];
  /** Recorded targets taken off the row because nothing was there. */
  cleared: HarnessName[];
  /** Recorded targets dropped by `--force` with nothing confirming them. */
  forced: HarnessName[];
  /** Known targets still on the row afterwards, however they got there. */
  stuck: HarnessName[];
  /** Target names this build cannot act on that went with the row anyway. */
  droppedUnknown: string[];
  write: 'none' | 'remove' | 'shorten';
  /** The `targets` a `shorten` writes back. */
  targets: unknown[];
  /** What the row looks like after the write; `none` once it is gone. */
  rowLeft: RowShape;
}

/** One thing that happened, at the level it deserves. A prompts class prints it. */
export interface SummaryLine {
  level: 'ok' | 'warn' | 'info';
  text: string;
}
