// The type model for the whole surface. Runtime code validates every JSON
// boundary itself; these types describe the already-validated results.

export type Env = Record<string, string | undefined>;

/** `platform` selects the *target* platform's path rules, not the host's. */
export interface PathOpts {
  platform?: string;
  env?: Env;
  home?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (file: string, args: string[], opts?: object) => Promise<RunResult>;

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
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'error' | 'manual';
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface MaterializedSource {
  dir: string;
  cleanup: () => void;
  via: 'git' | 'api' | string;
}

/** The injection seam the test suite is built on; every field defaults to the real thing. */
export interface Deps {
  fetchImpl?: FetchLike;
  env?: Env;
  materialize?: (args: {
    repo: string;
    ref: string;
    sourcePath: string;
    deps?: Deps;
  }) => Promise<MaterializedSource>;
  confirm?: (question: string, defaultYes: boolean) => boolean | Promise<boolean>;
  which?: (cmd: string, env?: Env) => string | null;
  run?: RunCommand;
  /** Where install/uninstall report what they did; absent means nobody is listening. */
  track?: TrackFn;
}

/** PathOpts plus the process-runner seam the Claude harness reads. */
export interface HarnessOpts extends PathOpts {
  run?: RunCommand;
}

export interface Profile {
  /** null means "read the name from the repo's marketplace.json". */
  id?: string | null;
  displayName?: string;
  repo?: string;
  ref?: string;
  label?: string;
  bin?: string;
  /** Mixpanel project token; null ships the brand without telemetry. */
  telemetryToken?: string | null;
  /** Ingestion host, which must match the project's data residency. */
  telemetryHost?: string;
}

export interface RcFile {
  repo?: string;
  ref?: string;
  marketplace?: string;
  displayName?: string;
  marketplaceLabel?: string;
  telemetry?: boolean;
}

export interface BrandTelemetry {
  /** null: this brand ships no telemetry. */
  readonly token: string | null;
  readonly host: string;
  /** The marketplace this build ships with; any other --repo is reported as "custom". */
  readonly defaultRepo: string;
  /** `"telemetry": false` in an rc file. */
  readonly rcOptOut: boolean;
}

export interface Brand {
  readonly repo: string;
  readonly ref: string;
  readonly id: string | null;
  readonly displayName: string;
  readonly label: string;
  readonly bin: string;
  readonly telemetry: BrandTelemetry;
}

export type HarnessName = 'claude' | 'cursor' | 'vscode';

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

/** An entry read() could act on: at least one target this build knows. */
export interface ManifestEntry {
  plugin: string;
  repo?: string;
  marketplace?: string;
  ref?: string;
  targets: HarnessName[];
  installedAt?: string;
  /** Unknown fields round-trip through read/write on purpose. */
  [key: string]: unknown;
}

/** `repo` completes the entry key: the same plugin id can be in two marketplaces. */
export interface IgnoredManifestEntry {
  plugin: string | null;
  repo?: string;
  reason: string;
}

/** An entry read() listed, minus the target names this build does not know. */
export interface ElidedTargets {
  plugin: string;
  repo?: string;
  targets: string[];
}

export interface Manifest {
  version: number;
  plugins: ManifestEntry[];
  ignored: IgnoredManifestEntry[];
  elided: ElidedTargets[];
}

/** Only `name` is checked on read; other fields are read through type checks. */
export interface CatalogPluginDetails {
  name: string;
  [key: string]: unknown;
}

export type CatalogPluginEntry = string | CatalogPluginDetails;

export interface Catalog {
  marketplace: string | null;
  plugins: CatalogPluginEntry[];
  /** Declared entries that had no usable name. */
  dropped: number;
  from: string;
}

export interface ResolvedPlugin {
  plugin: string;
  repo: string;
  ref: string;
  marketplace: string;
  sourcePath: string;
  description: string;
  catalogFound: boolean;
}

export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  checkout(sourcePath: string): Promise<string>;
}

export interface Session {
  marketplaces: Map<string, Promise<{ known: string; updated: boolean }>>;
  catalog(args: { repo: string; ref: string }): Promise<Catalog | null>;
  source(args: { repo: string; ref: string; sourcePath: string }): Promise<string | null>;
  cleanup(): Promise<void>;
}

/** `claude plugin marketplace list --json` entries; the shape varies by CLI version. */
export type MarketplaceListing = Record<string, unknown>;

/** `failed` means the file was left untouched: no object could be spliced into. */
export type AddLocationAction =
  | 'created'
  | 'reset'
  | 'already'
  | 'inserted-empty'
  | 'inserted-existing'
  | 'inserted-key'
  /** The path is already a key, but not the `"<key>": true` this tool writes. */
  | 'conflict'
  | 'failed';

/**
 * `absent` is a positive answer - the file does not name this path at all.
 * `unremovable` is not: the path IS named, in a form the splice does not
 * recognise, so VS Code may still be loading it. Callers must not read the two
 * as the same thing.
 */
export type RemoveLocationAction = 'missing' | 'absent' | 'unremovable' | 'removed';

export interface AddLocationResult {
  action: AddLocationAction;
  backup: string | null;
}

export interface RemoveLocationResult {
  action: RemoveLocationAction;
  backup: string | null;
}

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
  ok: boolean;
}

export interface Flags {
  repo?: string;
  ref?: string;
  marketplace?: string;
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

export interface InstallResult {
  plugin: string;
  targets: HarnessName[];
  /** Editors an earlier run installed into that this run left alone. */
  untouched?: HarnessName[];
  marketplace: string;
  ref: string;
}

export interface UninstallResult {
  plugin: string;
  /** Editors something was actually removed from - not editors whose record was corrected. */
  targets: HarnessName[];
  /** Editors that were asked and went wrong. Non-empty means the run failed. */
  failed: HarnessName[];
}

export interface UpdateResult {
  updated: string[];
  failed: { plugin: string; error: string }[];
}

export interface ListedPlugin {
  name: string;
  description: string;
  targets: HarnessName[];
  installed: boolean;
}

export interface ListResult {
  label: string;
  marketplace: string | null;
  repo: string;
  plugins: ListedPlugin[];
}

export interface Prompter {
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}

/** Flat by design: a property is a fact about the run, never a structure that could carry more. */
export type TelemetryValue = string | number | boolean | null;

export interface TelemetryEvent {
  name: string;
  properties: Record<string, TelemetryValue>;
}

export type TrackFn = (name: string, properties?: Record<string, TelemetryValue>) => void;

/** `log` prints what would be sent, to stderr, and sends nothing. */
export type TelemetryMode = 'on' | 'off' | 'log';

/**
 * Which switch turned telemetry off; `user` is the state file `telemetry disable`
 * writes, `state` that same file when it exists but cannot be read.
 */
export type TelemetryOptOut =
  'no-token' | 'DO_NOT_TRACK' | 'CP_TELEMETRY' | 'rc' | 'state' | 'user';

export interface TelemetryStatus {
  mode: TelemetryMode;
  optOut: TelemetryOptOut | null;
  /** The anonymous machine id, once one has been minted. */
  id: string | null;
  file: string;
}
