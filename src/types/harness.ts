import type { PathOpts } from './env.js';
import type { RunCommand } from './ports.js';
import type { Session } from './session.js';

// One editor's install strategy, and the vocabulary the rest of the program uses
// to talk about editors.

export type HarnessName = 'claude' | 'cursor' | 'vscode';

/**
 * Editor titles, and through them the list of editors this build knows. Static
 * data rather than something read off the harness modules, because a pure
 * decision has to be able to name an editor without importing the code that
 * installs into one - `uninstallLines` is the whole reason this lives here.
 *
 * `Record<HarnessName, string>` is total, so a name added to the union without
 * a title does not compile, and `NAMES` is derived from these keys rather than
 * written out again: there is one list, in one order, and nothing to forget.
 *
 * Frozen, like every other constant table here, because `isHarnessName` answers
 * from these keys on every call while `NAMES` is taken once at load: a name
 * assigned later would be a target this build claims to know and has no module
 * for, and `rowShape` would read it as a list rather than as foreign.
 */
export const TITLES: Readonly<Record<HarnessName, string>> = Object.freeze({
  claude: 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
});

export const isHarnessName = (name: unknown): name is HarnessName =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(TITLES, name);

/** Every editor this build knows, in the order everything lists them in. */
export const NAMES: readonly HarnessName[] = Object.keys(TITLES).filter(isHarnessName);

/** Editor titles in the order the caller's list gives, for prose that lists them. */
export const titlesOf = (names: readonly HarnessName[], sep = ', '): string =>
  names.map((n) => TITLES[n]).join(sep);

/**
 * Every editor this build knows, in prose. Derived from `NAMES` on purpose:
 * these lists are the one thing the compiler cannot keep honest when a harness
 * is added, so there is nothing here to forget to update. Pass a conjunction
 * for "a, b, or c"; omit it for the "a / b / c" form.
 */
export function everyEditor(conjunction?: string): string {
  if (!conjunction || NAMES.length < 2) return titlesOf(NAMES, ' / ');
  const last = TITLES[NAMES[NAMES.length - 1]];
  const head = NAMES.slice(0, -1);
  return `${titlesOf(head)}${head.length > 1 ? ',' : ''} ${conjunction} ${last}`;
}

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

/** One row of `claude plugin list --json`, as much of it as this build reads. */
export interface InstalledPlugin {
  plugin: string;
  /** null when the listing does not say, which counts as "could be ours". */
  scope: string | null;
}
