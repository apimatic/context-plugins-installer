import type { PathOpts } from './env.js';
import type { RunCommand } from './ports.js';
import type { Session } from './session.js';

// One editor's install strategy, and the vocabulary the rest of the program uses
// to talk about editors.

export type HarnessName = 'claude' | 'cursor' | 'vscode';

/** PathOpts plus the process-runner seam the Claude harness reads. */
export interface HarnessOpts extends PathOpts {
  run?: RunCommand;
}

export interface HarnessContext {
  plugin: string;
  marketplace: string | null;
  repo: string;
  srcDir?: string | null;
  session?: Session;
}

/**
 * `absent` is what keeps a drifted record from sticking: the harness looked and
 * positively established there is nothing to remove, so the row is wrong rather
 * than the run, and it is cleared. `skipped` is "could not look" - the editor is
 * not installed here, or there is no name to address it by - and `failed` is
 * "looked and it went wrong". Both keep the row; only `failed` fails the run.
 * Note every one of these is a truthy string: never test the result for truth.
 */
export type UninstallOutcome = 'removed' | 'absent' | 'skipped' | 'failed';

export interface Harness {
  name: HarnessName;
  title: string;
  /** Whether install needs the plugin files on disk (Claude installs from the marketplace itself). */
  needsSource: boolean;
  detect(opts?: HarnessOpts): boolean;
  /** Where detect looked; printed as "not installed (looked in ...)". */
  location(opts?: HarnessOpts): string;
  /** false means "skipped", not failed. */
  install(ctx: HarnessContext, opts?: HarnessOpts): Promise<boolean>;
  uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<UninstallOutcome>;
}

/** `claude plugin marketplace list --json` entries; the shape varies by CLI version. */
export type MarketplaceListing = Record<string, unknown>;
