import { DirectoryPath, HOST, type PathRules } from './file/paths.js';
import { Failure } from './failure.js';
import { PluginId } from './ids/plugin-id.js';
import { err, ok, type Result } from './result.js';

// What the user asked to install, validated once, at the front of the run. Every
// stage after `resolve` is told where the files are and what marketplace name to
// address; this is the value that decides which of those answers gets given.
//
// Two arms today. A `github` arm - a repository, or a folder inside one, that is
// itself a plugin - joins them; the consumers are written against
// `PluginSource` rather than either class, so widening it is one line here and a
// compile error at each site that has to learn about the new kind.

/**
 * A plugin id listed in a marketplace registry: the spelling this program has
 * always taken, and the only one a bare argument can be. The id is validated
 * here and nothing downstream re-checks it.
 */
export class MarketplaceSource {
  readonly kind = 'marketplace' as const;

  constructor(
    readonly plugin: PluginId,
    readonly repo: string,
    readonly ref: string,
  ) {}

  /**
   * The `repo` column of a manifest row. Unchanged for this arm, deliberately:
   * every record every released build has written keys on exactly this, so
   * there is nothing to migrate.
   */
  key(): string {
    return this.repo;
  }

  /**
   * The id telemetry may carry. A plugin listed in a marketplace has a public
   * name, so this is it.
   */
  reportableId(): PluginId | null {
    return this.plugin;
  }
}

/**
 * A directory on this machine that is itself a plugin. It carries no id: what
 * the plugin is called comes from its own manifest, which is read where the
 * files are - so this is only the answer to "which directory", and the run
 * learns the rest at the resolve stage.
 */
/** The one spelling of the prefix, so the writer and the reader cannot drift. */
const LOCAL_PREFIX = 'local:';

/**
 * Whether a recorded `repo` column came from a local source. A predicate rather
 * than a full parse because that is all its caller needs: a `repo` no slug can
 * ever be.
 */
export const isLocalKey = (repo: unknown): repo is string =>
  typeof repo === 'string' && repo.startsWith(LOCAL_PREFIX);

/**
 * The directory a recorded `repo` column names, or null when it names a
 * repository. Beside `isLocalKey` so the prefix has one spelling: a reader that
 * sliced it off itself is a second definition of the key format.
 */
export const localDirOf = (repo: unknown): string | null =>
  isLocalKey(repo) ? repo.slice(LOCAL_PREFIX.length) : null;

export class LocalSource {
  readonly kind = 'local' as const;

  constructor(readonly dir: DirectoryPath) {}

  /**
   * The `repo` column for a local install. Prefixed so it can never collide
   * with a slug, and absolute as resolved at install time - `RepoSlug.same`
   * folds this column's case when a row is looked up, which is right on Windows
   * and macOS and an over-match on Linux that costs a rare pair of paths
   * differing only in case.
   */
  key(): string {
    return `${LOCAL_PREFIX}${this.dir.toString()}`;
  }

  /**
   * Withheld. A local plugin's name comes from a folder the user chose, which
   * makes it their name and not a public one - so it does not leave the
   * machine, and the decision is here rather than in a command that would have
   * to remember.
   */
  reportableId(): PluginId | null {
    return null;
  }
}

export type PluginSource = MarketplaceSource | LocalSource;

/** Which `source_kind` telemetry reports, and the one place the names are spelled. */
export type SourceKind = PluginSource['kind'];

export interface ParseSourceOptions {
  /** The configured marketplace, for the arm that installs from one. */
  repo: string;
  ref: string;
  /** What a relative path is relative to. Given, never read from `process`. */
  cwd: string;
  home: string;
  /** The target platform's rules, so a Windows path is assertable from Linux. */
  rules?: PathRules;
}

/**
 * Anything that has to be a path rather than an id: a leading `.`, a separator,
 * a `~`, or a drive letter. None of these can begin a `PluginId`, which is
 * checked first anyway - so nothing about the spelling this program has always
 * taken can be read as a path.
 */
const PATH_LIKE = /^(?:[.~]|[/\\]|[A-Za-z]:[/\\])/;

/** `~`, `~/x` and `~\x`; a name merely starting with a tilde is not a home path. */
const HOME_PREFIXED = /^~[/\\]/;

function localSource(
  spec: string,
  { cwd, home, rules }: Required<ParseSourceOptions>,
): LocalSource {
  const expanded =
    spec === '~' ? home : HOME_PREFIXED.test(spec) ? rules.join(home, spec.slice(2)) : spec;
  // Absolute against the cwd we were given: a row records where the plugin was,
  // and "wherever that shell happened to be" is not somewhere `update` can look.
  return new LocalSource(new DirectoryPath(rules.resolve(cwd, expanded), rules));
}

/**
 * What the user typed, as the source it names. Pure - it decides the shape and
 * touches nothing, so whether a directory actually holds a plugin is a question
 * for the reader that goes and looks.
 *
 * The id is tried first, which is what guarantees that no argument this program
 * already accepted changes meaning. Anything that is neither an id nor
 * path-shaped keeps the id's own failure, so a typo still reads as a typo.
 */
export function parseSource(
  spec: unknown,
  { repo, ref, cwd, home, rules = HOST }: ParseSourceOptions,
): Result<PluginSource, Failure> {
  const id = PluginId.parse(spec);
  if (id.ok) return ok(new MarketplaceSource(id.value, repo, ref));
  if (typeof spec === 'string' && PATH_LIKE.test(spec)) {
    return ok(localSource(spec, { repo, ref, cwd, home, rules }));
  }
  return err(id.error);
}
