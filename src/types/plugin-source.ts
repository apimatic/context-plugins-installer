import { DirectoryPath, HOST, type PathRules } from './file/paths.js';
import { Failure } from './failure.js';
import { GitRef } from './ids/git-ref.js';
import { PluginId } from './ids/plugin-id.js';
import { RepoSlug } from './ids/repo-slug.js';
import { err, ok, type Result } from './result.js';

// What the user asked to install, parsed once at the front of the run: a plugin listed
// in a marketplace registry, a repository (or a folder inside one) that is itself a
// plugin, or a directory on this machine.

export class MarketplaceSource {
  readonly kind = 'marketplace' as const;

  constructor(
    readonly plugin: PluginId,
    readonly repo: string,
    readonly ref: string,
  ) {}

  /** The manifest row's `repo` column. */
  key(): string {
    return this.repo;
  }

  reportableId(): PluginId | null {
    return this.plugin;
  }

  toString(): string {
    return `${this.repo}@${this.ref}`;
  }
}

const LOCAL_PREFIX = 'local:';
const GITHUB_PREFIX = 'github:';

export const isLocalKey = (repo: unknown): repo is string =>
  typeof repo === 'string' && repo.startsWith(LOCAL_PREFIX);

export const localDirOf = (repo: unknown): string | null =>
  isLocalKey(repo) ? repo.slice(LOCAL_PREFIX.length) : null;

export const isGithubKey = (repo: unknown): repo is string =>
  typeof repo === 'string' && repo.startsWith(GITHUB_PREFIX);

/** The halves are joined by `//`: a single slash would make `acme/mono/tools` ambiguous. */
export const githubOf = (repo: unknown): { repo: string; path: string | null } | null => {
  if (!isGithubKey(repo)) return null;
  const rest = repo.slice(GITHUB_PREFIX.length);
  const cut = rest.indexOf('//');
  if (cut === -1) return { repo: rest, path: null };
  return { repo: rest.slice(0, cut), path: rest.slice(cut + 2) || null };
};

/**
 * A repository, or a folder inside one, that is itself a plugin. It carries no id: what
 * the plugin is called comes from its own manifest, read where the files are.
 */
export class GithubSource {
  readonly kind = 'github' as const;

  constructor(
    /** Validated as a slug at parse time; carried as a string. */
    readonly repo: string,
    readonly ref: string,
    readonly path: string | null,
  ) {}

  key(): string {
    const under = this.path === null ? '' : `//${this.path}`;
    return `${GITHUB_PREFIX}${this.repo}${under}`;
  }

  reportableId(): PluginId | null {
    return null;
  }

  toString(): string {
    const under = this.path === null ? '' : `/${this.path}`;
    return `${this.repo}${under}@${this.ref}`;
  }
}

export class LocalSource {
  readonly kind = 'local' as const;

  constructor(readonly dir: DirectoryPath) {}

  /** Looked up through `RepoSlug.same`, which folds case - an over-match on Linux. */
  key(): string {
    return `${LOCAL_PREFIX}${this.dir.toString()}`;
  }

  reportableId(): PluginId | null {
    return null;
  }

  toString(): string {
    return this.dir.toString();
  }
}

export type PluginSource = MarketplaceSource | GithubSource | LocalSource;

/** Sources this program was not shipped pointing at - what the trust question is about. */
export type UntrustedSource = GithubSource | LocalSource;

export type SourceKind = PluginSource['kind'];

export interface ParseSourceOptions {
  repo: string;
  ref: string;
  cwd: string;
  home: string;
  rules?: PathRules;
}

const PATH_LIKE = /^(?:[.~]|[/\\]|[A-Za-z]:[/\\])/;

const HOME_PREFIXED = /^~[/\\]/;

const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i;
const SCP_ADDRESS = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i;
const REMOTE_LIKE = /^(?:https?:\/\/|(?:ssh:\/\/)?git@)/i;

function localSource(
  spec: string,
  { cwd, home, rules }: Required<ParseSourceOptions>,
): LocalSource {
  const expanded =
    spec === '~' ? home : HOME_PREFIXED.test(spec) ? rules.join(home, spec.slice(2)) : spec;
  return new LocalSource(new DirectoryPath(rules.resolve(cwd, expanded), rules));
}

const notARepo = (spec: string): Failure =>
  new Failure(
    `'${spec}' is not a plugin id, a path, or a GitHub repository.`,
    'Expected owner/repo, owner/repo/folder, or a github.com URL - or ./my-plugin for a directory on this machine.',
  );

/**
 * Reaches `git sparse-checkout add` as argv, where a leading `-` reads as an option, and
 * a raw.githubusercontent.com URL as a path, where a `?` or a `#` truncates the request.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.+-]*$/;

const badFolder = (spec: string, segment: string): Failure =>
  new Failure(
    `'${segment}' is not a usable folder name in '${spec}'.`,
    'A folder inside a repository may hold letters, digits, dots, dashes and underscores.',
  );

function repoPath(segments: readonly string[], spec: string): Result<string | null, Failure> {
  if (!segments.length) return ok(null);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment)) {
      return err(badFolder(spec, segment));
    }
  }
  return ok(segments.join('/'));
}

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

  // `github.com/acme/mono/tree/v2/tools/foo` - one segment of ref, then the folder.
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
  plugin: PluginId;
  ref: string;
  rules?: PathRules;
}

/**
 * Total: a column with no prefix this build knows is a marketplace repo, which is what
 * every row written before these prefixes existed holds.
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

export const sourceKindOf = (repo: unknown): SourceKind =>
  isLocalKey(repo) ? 'local' : isGithubKey(repo) ? 'github' : 'marketplace';
