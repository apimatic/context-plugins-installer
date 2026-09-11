import type { PathOpts } from './env.js';
import type { Failure } from './failure.js';
import type { Result } from './result.js';
import type { DirectoryPath, FilePath } from './file/paths.js';
import type { MarketplaceOrigin } from './marketplace-origin.js';
import type { ProcessRunner } from './ports.js';
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

/**
 * What a run that changed nothing says. Derived from the editor list like the
 * lines above, and shared by the uninstall decision and the install summary -
 * two layers that cannot see each other, which is why it is here.
 */
export const nothingChanged = (): string => `Nothing was changed. Are ${everyEditor()} installed?`;

/** PathOpts plus the process-runner seam the Claude harness reads. */
export interface HarnessOpts extends PathOpts {
  /**
   * The process table, for the one harness that shells out. A service rather
   * than a bare `run` so that finding a binary and spawning it cannot read
   * different environments.
   */
  runner?: ProcessRunner;
}

/**
 * Which way round a run is going. Only the lines that differ between the two
 * take it - the reload hint, mostly, which has to say load or unload.
 */
export type HarnessVerb = 'install' | 'uninstall';

/**
 * What an editor whose install is a directory copy can report. Cursor and VS
 * Code say all six of these in the same words, so they are one template each
 * with the title filled in rather than a pair that can drift - the same reason
 * `TITLES` exists.
 */
type CopyEvent =
  | { kind: 'not-installed'; root: DirectoryPath }
  | { kind: 'no-source' }
  | { kind: 'copied'; dest: DirectoryPath }
  | { kind: 'removed'; dest: DirectoryPath }
  | { kind: 'nothing-to-remove'; dest: DirectoryPath }
  | { kind: 'reload'; after: HarnessVerb };

/** The shared half of both file-copying editors, as one prompts class sees it. */
export type EditorEvent = { harness: 'cursor' | 'vscode' } & CopyEvent;

export type CursorEvent = { harness: 'cursor' } & (CopyEvent | { kind: 'no-plugin-json' });

/**
 * VS Code's copy is registered in a settings file the user also edits, so most
 * of what it has to say is about that file: which shape of entry it found, and
 * what to write by hand when the splice could not.
 */
export type VscodeEvent = { harness: 'vscode' } & (
  | CopyEvent
  | { kind: 'unregistered-only'; dest: DirectoryPath }
  | { kind: 'settings-failed'; settings: FilePath; dest: DirectoryPath }
  | { kind: 'settings-conflict'; settings: FilePath; dest: DirectoryPath }
  | { kind: 'settings-already'; settings: FilePath }
  | { kind: 'settings-registered'; settings: FilePath }
  | { kind: 'settings-unregistered'; settings: FilePath }
  | { kind: 'settings-unremovable'; settings: FilePath; dest: DirectoryPath }
  | { kind: 'settings-backed-up'; backup: FilePath }
);

/**
 * Claude Code installs through its own CLI, up to five calls of it, so these are
 * the steps of that conversation: which name the marketplace is filed under,
 * whether the local copy had to be refreshed, and what the install said. Exit
 * codes and the tail of the output travel as facts - deciding what they mean is
 * the harness's job, and saying it is this file's.
 */
export type ClaudeEvent = { harness: 'claude' } & (
  | { kind: 'cli-missing' }
  | { kind: 'no-marketplace-name'; after: HarnessVerb }
  | { kind: 'marketplace-renamed'; known: string; configured: string }
  | { kind: 'marketplace-registered'; known: string }
  | { kind: 'marketplace-updated'; known: string }
  | { kind: 'marketplace-update-failed'; known: string; code: number; detail: string }
  | { kind: 'marketplace-added'; marketplace: string }
  | { kind: 'marketplace-add-rejected'; code: number; detail: string }
  | { kind: 'plugin-stale'; target: string; known: string }
  | { kind: 'plugin-installed'; target: string; scope: string }
  | { kind: 'plugin-absent'; plugin: string; scope: string }
  | { kind: 'plugin-uninstalled'; target: string }
  | { kind: 'marketplace-removed'; known: string }
  | { kind: 'staging-left'; detail: string }
  | { kind: 'plugin-uninstall-failed'; target: string; code: number; detail: string }
  | { kind: 'reload'; after: HarnessVerb }
);

/**
 * What a harness did, as facts rather than sentences. A prompts class turns each
 * into the line it has always been, which is what lets a harness report five
 * steps of a slow install without knowing there is a terminal - and what keeps
 * each line where it was, since a warning is only useful before the work it
 * explains, not after.
 *
 * Every event names its editor. The lines usually need the title anyway, it
 * makes a recorded event say what it is about without its surroundings, and it
 * is what lets one listener render whichever harness a loop reaches next.
 */
export type HarnessEvent = ClaudeEvent | CursorEvent | VscodeEvent;

export type HarnessListener = (event: HarnessEvent) => void;

export interface HarnessContext {
  plugin: string;
  /**
   * Where the plugin's marketplace lives, and what Claude Code addresses it by.
   * One value rather than the name and the repo as two fields: they travelled
   * together through every layer, and nothing stopped the two from disagreeing.
   * Named for what it holds, so no reader has to rename it to read it.
   */
  origin: MarketplaceOrigin;
  /** Where the plugin's files are, for a harness whose install is a copy. */
  srcDir?: DirectoryPath | null;
  session?: Session;
  /** Where the harness says what it did. Required: a dropped line is a bug. */
  listener: HarnessListener;
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

/**
 * What an install did. Named rather than a boolean for the same reason the
 * uninstall outcomes are: `false` invited being read as failure, when it means
 * the editor was not there to install into. A real failure is the `Failure` arm
 * of the `Result` - an editor that looked and could not, which is the user's to
 * fix and the run's to report as such. A harness does not throw for that: a
 * throw out of one is a bug, and telemetry counts the two apart.
 */
export type InstallOutcome = 'installed' | 'skipped';

export interface Harness {
  name: HarnessName;
  title: string;
  /** Whether install needs the plugin files on disk (Claude installs from the marketplace itself). */
  needsSource: boolean;
  detect(opts?: HarnessOpts): boolean;
  /**
   * Where detect looked, for "not installed (looked in ...)": a path for an
   * editor with a root on disk, and prose for one found on `$PATH`. The caller
   * renders it, because a harness cannot reach the formatter.
   */
  location(opts?: HarnessOpts): DirectoryPath | string;
  install(ctx: HarnessContext, opts?: HarnessOpts): Promise<Result<InstallOutcome, Failure>>;
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
