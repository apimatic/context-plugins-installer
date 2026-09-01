/**
 * The type model for the TypeScript port.
 *
 * Designed against the current JavaScript, before any of it is converted:
 * every shape below is what the code actually passes around today, so the
 * port changes syntax, not behaviour. Runtime code does not import this
 * file - the JSON boundaries (manifest, registry, rc file, `claude
 * plugin marketplace list`) are enforced by validation in the modules
 * themselves, and these types describe the already-validated results.
 *
 * Deliberately dependency-free: no DOM lib, no @types/node. Environment and
 * fetch are modelled structurally so this file typechecks bare.
 */

/** A subset of process.env; also what tests inject to sandbox PATH lookups. */
export type Env = Record<string, string | undefined>;

// ---- cross-platform path resolution (src/paths.js) --------------------------

/**
 * Overrides for path resolution, so the cross-platform table is testable from
 * any host. `platform` is a process.platform value and selects the join rules
 * of the *target* platform, not the host's.
 */
export interface PathOpts {
  platform?: string;
  env?: Env;
  home?: string;
}

// ---- child processes (src/util.js) ------------------------------------------

/** What util.run resolves with; a spawn error rejects instead. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (file: string, args: string[], opts?: object) => Promise<RunResult>;

// ---- injected dependencies ---------------------------------------------------

/** The response surface the code relies on; satisfied by global fetch. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'follow' | 'error' | 'manual' },
) => Promise<FetchResponseLike>;

/** What deps.materialize (and fetch.materialize) resolves with. */
export interface MaterializedSource {
  dir: string;
  cleanup: () => void;
  via: 'git' | 'api' | string;
}

/**
 * The dependency bag threaded through install/catalog/fetch/doctor. Every
 * field is optional; the real implementation is the default. This is the seam
 * the whole test suite is built on.
 */
export interface Deps {
  fetchImpl?: FetchLike;
  env?: Env;
  materialize?: (args: {
    repo: string;
    ref: string;
    sourcePath: string;
    deps?: Deps;
  }) => Promise<MaterializedSource>;
  /** Answers harness questions headlessly (bypasses the interactive prompter). */
  confirm?: (question: string, defaultYes: boolean) => boolean | Promise<boolean>;
  /** doctor only: PATH lookup override. */
  which?: (cmd: string, env?: Env) => string | null;
  /** doctor only: process runner override. */
  run?: RunCommand;
}

/**
 * The second argument every harness receives. It is a PathOpts, plus the
 * process-runner seam the Claude harness reads (`opts.run`) so tests can fake
 * the `claude` CLI.
 */
export interface HarnessOpts extends PathOpts {
  run?: RunCommand;
}

// ---- brand / configuration (src/brand.js) ------------------------------------

/** Preset configuration passed programmatically (see run.js). */
export interface Profile {
  /** Marketplace name; null means "read it from the repo's marketplace.json". */
  id?: string | null;
  displayName?: string;
  repo?: string;
  ref?: string;
  label?: string;
  bin?: string;
}

/** A validated .contextpluginsrc: unknown fields ignored, known fields strings. */
export interface RcFile {
  repo?: string;
  ref?: string;
  marketplace?: string;
  displayName?: string;
  marketplaceLabel?: string;
}

/** The resolved, frozen configuration every command runs against. */
export interface Brand {
  readonly repo: string;
  readonly ref: string;
  readonly id: string | null;
  readonly displayName: string;
  readonly label: string;
  readonly bin: string;
}

// ---- harnesses (src/harness/) ------------------------------------------------

export type HarnessName = 'claude' | 'cursor' | 'vscode';

/** What install hands each harness. uninstall receives the same minus srcDir/session. */
export interface HarnessContext {
  plugin: string;
  marketplace: string | null;
  repo: string;
  srcDir?: string | null;
  session?: Session;
}

export interface Harness {
  name: HarnessName;
  title: string;
  /** Whether install needs the plugin files on disk (Claude installs from the marketplace itself). */
  needsSource: boolean;
  detect(opts?: HarnessOpts): boolean;
  /** Where detect looked, for "not installed (looked in ...)" messages. */
  location(opts?: HarnessOpts): string;
  /** true when something was installed; false is "skipped", not an error. */
  install(ctx: HarnessContext, opts?: HarnessOpts): Promise<boolean>;
  uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<boolean>;
}

// ---- manifest (src/manifest.js) ----------------------------------------------

/**
 * One recorded install, post-validation: plugin is a non-empty string and
 * targets holds at least one name this build knows. Entries that cannot
 * satisfy that are dropped on read, so downstream `byName(name)` lookups on
 * manifest data cannot miss.
 */
export interface ManifestEntry {
  plugin: string;
  repo?: string;
  marketplace?: string;
  ref?: string;
  targets: HarnessName[];
  installedAt?: string;
  /** Unknown fields round-trip through read/write on purpose (forward compat). */
  [key: string]: unknown;
}

/** A raw entry read() could not act on, and the reason - for the CLI to surface. */
export interface IgnoredManifestEntry {
  plugin: string | null;
  reason: string;
}

export interface Manifest {
  version: number;
  plugins: ManifestEntry[];
  ignored: IgnoredManifestEntry[];
}

// ---- marketplace registry (src/catalog.js) -----------------------------------

/**
 * The object form of a registry entry. Only `name` is checked on read;
 * `description` and `source` are read through type checks where they are
 * used, so the declared type stays honest about what a third-party registry
 * can ship.
 */
export interface CatalogPluginDetails {
  name: string;
  [key: string]: unknown;
}

/** Registries list plugins as bare ids or as objects; both flow through as-is. */
export type CatalogPluginEntry = string | CatalogPluginDetails;

export interface Catalog {
  /** The registry's `name`, or null when it has none (resolve then requires --marketplace). */
  marketplace: string | null;
  plugins: CatalogPluginEntry[];
  /** Declared entries that were unusable (no string name) and got dropped. */
  dropped: number;
  /** Which registry file answered (.claude-plugin/... or .cursor-plugin/...). */
  from: string;
}

/** Everything the installers need for one plugin, resolved from the registry. */
export interface ResolvedPlugin {
  plugin: string;
  repo: string;
  ref: string;
  marketplace: string;
  /** Repo-relative folder holding the plugin's files. */
  sourcePath: string;
  description: string;
  catalogFound: boolean;
}

// ---- fetch (src/fetch.js) ------------------------------------------------------

/** An open repo@ref that checks plugin folders out on demand. */
export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  /** Resolves to the local directory holding that folder's files. */
  checkout(sourcePath: string): Promise<string>;
}

// ---- session (src/session.js) --------------------------------------------------

/** Work shared by every plugin in one command; see createSession. */
export interface Session {
  /** Claude marketplace registrations, memoized by the harness (keyed repo::marketplace). */
  marketplaces: Map<string, Promise<{ known: string; updated: boolean }>>;
  catalog(args: { repo: string; ref: string }): Promise<Catalog | null>;
  source(args: { repo: string; ref: string; sourcePath: string }): Promise<string | null>;
  cleanup(): Promise<void>;
}

// ---- claude CLI output (src/harness/claude.js) ---------------------------------

/**
 * One entry of `claude plugin marketplace list --json`. The shape has varied
 * across CLI versions, so only "it is an object" is checked on read; repoOf()
 * probes the known spellings (repo, url, source) through type checks and
 * falls back to a full-text search.
 */
export type MarketplaceListing = Record<string, unknown>;

// ---- settings merge (src/settings-merge.js) ------------------------------------

export type AddLocationAction =
  'created' | 'reset' | 'already' | 'inserted-empty' | 'inserted-existing' | 'inserted-key';

export type RemoveLocationAction = 'missing' | 'absent' | 'removed';

export interface AddLocationResult {
  action: AddLocationAction;
  /** Path of the settings.json backup, when one was taken. */
  backup: string | null;
}

export interface RemoveLocationResult {
  action: RemoveLocationAction;
  backup: string | null;
}

// ---- doctor (src/doctor.js) ------------------------------------------------------

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  status: DoctorStatus;
  label: string;
  detail: string;
  hint?: string;
}

export interface DoctorGroup {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  groups: DoctorGroup[];
  failures: number;
  warnings: number;
  /** No failures; warnings alone stay ok. */
  ok: boolean;
}

// ---- CLI (src/cli.js) --------------------------------------------------------------

export interface Flags {
  repo?: string;
  ref?: string;
  marketplace?: string;
  /** Raw comma-separated value; parseTargets splits it. */
  targets?: string;
  force?: boolean;
  yes?: boolean;
  long?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface ParsedArgs {
  command: string | null;
  args: string[];
  flags: Flags;
}

// ---- command results (src/install.js) ----------------------------------------------

export interface InstallResult {
  plugin: string;
  /** What this run actually installed into. */
  targets: HarnessName[];
  /** Editors an earlier run installed into that this run left alone. */
  untouched?: HarnessName[];
  marketplace: string;
  ref: string;
}

export interface UninstallResult {
  plugin: string;
  targets: HarnessName[];
}

export interface UpdateResult {
  updated: string[];
  failed: { plugin: string; error: string }[];
}

export interface ListedPlugin {
  name: string;
  description: string;
  /** Editors this plugin is recorded as installed into (empty when not installed). */
  targets: HarnessName[];
  installed: boolean;
}

export interface ListResult {
  label: string;
  marketplace: string | null;
  repo: string;
  plugins: ListedPlugin[];
}

// ---- prompt (src/prompt.js) -----------------------------------------------------------

export interface Prompter {
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}
