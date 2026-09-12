import { DirectoryPath, HOST, type PathRules } from './file/paths.js';
import { Failure } from './failure.js';
import { GitRef } from './ids/git-ref.js';
import { PluginId } from './ids/plugin-id.js';
import { RepoSlug } from './ids/repo-slug.js';
import { err, ok, type Result } from './result.js';

// What the user asked to install, validated once, at the front of the run. Every
// stage after `resolve` is told where the files are and what marketplace name to
// address; this is the value that decides which of those answers gets given.
//
// Three arms: a plugin listed in a marketplace registry, a repository (or a
// folder inside one) that is itself a plugin, and a directory on this machine.
// The consumers are written against `PluginSource` rather than any one class,
// so a fourth kind is one arm here and a compile error at each site that has to
// learn about it.

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
   * The id telemetry may carry, and the only arm that carries one: a plugin
   * listed in a marketplace this project publishes has a public name, and one
   * the run knew before it started.
   */
  reportableId(): PluginId | null {
    return this.plugin;
  }

  /** Where the plugin came from, the question every arm's `toString` answers. */
  toString(): string {
    return `${this.repo}@${this.ref}`;
  }
}

/** The one spelling of each prefix, so the writer and the readers cannot drift. */
const LOCAL_PREFIX = 'local:';
const GITHUB_PREFIX = 'github:';

/**
 * Whether a recorded `repo` column came from a local source. A predicate rather
 * than a full parse because that is all its caller needs: a `repo` no slug can
 * ever be.
 */
export const isLocalKey = (repo: unknown): repo is string =>
  typeof repo === 'string' && repo.startsWith(LOCAL_PREFIX);

/**
 * The directory a recorded `repo` column names, or null when it names anything
 * else. Beside `isLocalKey` so the prefix has one spelling: a reader that
 * sliced it off itself is a second definition of the key format.
 */
export const localDirOf = (repo: unknown): string | null =>
  isLocalKey(repo) ? repo.slice(LOCAL_PREFIX.length) : null;

export const isGithubKey = (repo: unknown): repo is string =>
  typeof repo === 'string' && repo.startsWith(GITHUB_PREFIX);

/**
 * The repository and folder a recorded `repo` column names, or null when it
 * names anything else. The two halves are separated by `//` because a folder
 * inside a repository is the whole reason two rows from one repository stay
 * distinct, and a single slash would make `acme/mono/tools` read three ways.
 */
export const githubOf = (repo: unknown): { repo: string; path: string | null } | null => {
  if (!isGithubKey(repo)) return null;
  const rest = repo.slice(GITHUB_PREFIX.length);
  const cut = rest.indexOf('//');
  if (cut === -1) return { repo: rest, path: null };
  return { repo: rest.slice(0, cut), path: rest.slice(cut + 2) || null };
};

/**
 * A repository, or a folder inside one, that is itself a plugin - rather than a
 * marketplace listing others. It carries no id: what the plugin is called comes
 * from its own manifest, which is read where the files are, so this is only the
 * answer to "which repository, at which ref, and which folder of it".
 */
export class GithubSource {
  readonly kind = 'github' as const;

  constructor(
    /** Validated as a slug at parse time; carried as a string, like `brand.repo`. */
    readonly repo: string,
    readonly ref: string,
    /** A folder inside the repository, or null for the repository itself. */
    readonly path: string | null,
  ) {}

  key(): string {
    const under = this.path === null ? '' : `//${this.path}`;
    return `${GITHUB_PREFIX}${this.repo}${under}`;
  }

  /**
   * Withheld, for the reason a directory's is. The name comes from a
   * repository the user named, which is the same class of thing as the
   * `--repo` this program already refuses to send - a repository can be
   * private, and a plugin nobody but its author can install is not a public
   * plugin name. Nothing downstream could act on a third party's id anyway.
   */
  reportableId(): PluginId | null {
    return null;
  }

  toString(): string {
    const under = this.path === null ? '' : `/${this.path}`;
    return `${this.repo}${under}@${this.ref}`;
  }
}

/**
 * A directory on this machine that is itself a plugin. It carries no id: what
 * the plugin is called comes from its own manifest, which is read where the
 * files are - so this is only the answer to "which directory", and the run
 * learns the rest at the resolve stage.
 */
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

  toString(): string {
    return this.dir.toString();
  }
}

export type PluginSource = MarketplaceSource | GithubSource | LocalSource;

/**
 * A source this program was not shipped pointing at, which is exactly the set
 * the trust question is about: a plugin from either of these can carry hooks
 * and MCP servers that run commands.
 */
export type UntrustedSource = GithubSource | LocalSource;

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

/** A URL or an scp-style git address, either of which names github.com outright. */
const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i;
const SCP_ADDRESS = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i;
const REMOTE_LIKE = /^(?:https?:\/\/|(?:ssh:\/\/)?git@)/i;

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

const notARepo = (spec: string): Failure =>
  new Failure(
    `'${spec}' is not a plugin id, a path, or a GitHub repository.`,
    'Expected owner/repo, owner/repo/folder, or a github.com URL - or ./my-plugin for a directory on this machine.',
  );

/**
 * What a folder inside a repository may be spelled with. Validated here for
 * exactly the reason a ref and an id are: it reaches `git sparse-checkout add`
 * as argv, where a leading `-` reads as an option, and a
 * raw.githubusercontent.com URL as a path, where a `?` or a `#` truncates the
 * request - which would read some other file as the plugin's manifest.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.+-]*$/;

const badFolder = (spec: string, segment: string): Failure =>
  new Failure(
    `'${segment}' is not a usable folder name in '${spec}'.`,
    'A folder inside a repository may hold letters, digits, dots, dashes and underscores.',
  );

/**
 * A folder inside a repository, as a clean relative path. `..` is refused
 * rather than resolved: the segments name a checkout this program will make,
 * and climbing out of one is never what the user meant.
 */
function repoPath(segments: readonly string[], spec: string): Result<string | null, Failure> {
  if (!segments.length) return ok(null);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment)) {
      return err(badFolder(spec, segment));
    }
  }
  return ok(segments.join('/'));
}

/**
 * A repository that is itself a plugin, in every spelling GitHub hands out: a
 * bare slug, a slug with a folder, a `tree` URL, and the scp-style address
 * `git clone` prints. An `@ref` at the end wins over the run's `--ref`, which
 * is the existing precedence extended by one step.
 *
 * A `.git` suffix is dropped, because it is part of a clone address rather than
 * of the repository's name - and a ref carrying a `/` is why the inline one is
 * split at the *last* `@` rather than matched: `acme/x@release/1.0` is a
 * spelling a user will type.
 */
function parseGithub(spec: string, ref: string): Result<GithubSource, Failure> {
  const scp = SCP_ADDRESS.exec(spec);
  const url = GITHUB_URL.exec(spec);
  let rest = scp?.[1] ?? url?.[1] ?? spec;
  let inline: string | null = null;

  if (!scp && !url) {
    const at = rest.lastIndexOf('@');
    if (at > 0 && at < rest.length - 1) {
      inline = rest.slice(at + 1);
      rest = rest.slice(0, at);
    }
  }

  const segments = rest
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  const [owner, name, ...tail] = segments;
  if (!owner || !name) return err(notARepo(spec));

  // `github.com/acme/mono/tree/v2/tools/foo` - the ref is one segment, which is
  // all a URL can say unambiguously, and the rest of it is the folder.
  let folder = tail;
  if (url && tail[0] === 'tree' && tail.length >= 2) {
    inline = tail[1] as string;
    folder = tail.slice(2);
  }

  const slug = RepoSlug.parse(`${owner}/${name}`);
  if (!slug.ok) return err(notARepo(spec));
  const gitRef = GitRef.parse(inline ?? ref);
  if (!gitRef.ok) return err(gitRef.error);
  const path = repoPath(folder, spec);
  if (!path.ok) return err(path.error);

  return ok(new GithubSource(slug.value.toString(), gitRef.value.toString(), path.value));
}

/**
 * What the user typed, as the source it names. Pure - it decides the shape and
 * touches nothing, so whether a directory or a repository actually holds a
 * plugin is a question for the reader that goes and looks.
 *
 * The id is tried first, which is what guarantees that no argument this program
 * already accepted changes meaning. A path is next, because a drive letter and
 * a leading `.` are unambiguous; anything else holding a `/` is a repository,
 * which is why a relative path has to be spelled `./my-plugin` rather than
 * `my-plugin/`. Anything with neither keeps the id's own failure, so a typo
 * still reads as a typo.
 */
export function parseSource(
  spec: unknown,
  { repo, ref, cwd, home, rules = HOST }: ParseSourceOptions,
): Result<PluginSource, Failure> {
  const id = PluginId.parse(spec);
  if (id.ok) return ok(new MarketplaceSource(id.value, repo, ref));
  if (typeof spec !== 'string') return err(id.error);
  if (PATH_LIKE.test(spec)) return ok(localSource(spec, { repo, ref, cwd, home, rules }));
  if (REMOTE_LIKE.test(spec) || spec.includes('/')) return parseGithub(spec, ref);
  return err(id.error);
}

export interface RestoreOptions {
  /** The id the row is keyed by, for the arm that carries one. */
  plugin: PluginId;
  /** The run's ref, for a row that did not record one. */
  ref: string;
  rules?: PathRules;
}

/**
 * A recorded `repo` column back as the source it was written from, for the
 * commands that act on a row rather than on an argument. Total: a column this
 * build cannot read as one of the prefixed kinds is a marketplace repo, which
 * is what every row written before those prefixes existed holds - and a row
 * must never become unreachable because its key looks odd.
 */
export function restoreSource(
  repo: unknown,
  { plugin, ref, rules = HOST }: RestoreOptions,
): PluginSource {
  const dir = localDirOf(repo);
  if (dir !== null) return new LocalSource(new DirectoryPath(dir, rules));
  const gh = githubOf(repo);
  if (gh) return new GithubSource(gh.repo, ref, gh.path);
  return new MarketplaceSource(plugin, typeof repo === 'string' ? repo : '', ref);
}

/**
 * Which kind of source a recorded row came from, without building one. For the
 * callers that only need to branch - `update` refreshes a marketplace row and
 * reports the others - so they do not each have to know what a prefix means.
 */
export const sourceKindOf = (repo: unknown): SourceKind =>
  isLocalKey(repo) ? 'local' : isGithubKey(repo) ? 'github' : 'marketplace';
