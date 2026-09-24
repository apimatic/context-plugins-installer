import { formatOf } from './archive.js';
import { DirectoryPath, FilePath, HOST, type PathRules } from './file/paths.js';
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

const ARCHIVE_PREFIX = 'archive:';

export const isArchiveKey = (repo: unknown): repo is string =>
  typeof repo === 'string' && repo.startsWith(ARCHIVE_PREFIX);

/** Where an archive's bytes are. One source class covers both, because only this differs. */
export type ArchiveAt = { kind: 'url'; url: string } | { kind: 'file'; file: FilePath };

/**
 * A zip or a tarball that is itself a plugin, at an https URL or on this
 * machine. Like a repository it carries no id - what the plugin is called comes
 * from its own manifest, read once the archive is open - and like a folder
 * inside a repository it can name one inside the archive.
 */
export class ArchiveSource {
  readonly kind = 'archive' as const;

  constructor(
    readonly at: ArchiveAt,
    /** The folder inside the archive, from the `#` fragment. */
    readonly path: string | null,
  ) {}

  /**
   * The archive itself, without the folder inside it. What a reader is named
   * after, and the reason two rows out of one archive share a download: the
   * handle is per archive, and only the extraction is per folder.
   */
  location(): string {
    return this.at.kind === 'url' ? this.at.url : this.at.file.toString();
  }

  /** The URL or the absolute path, and the fragment the user wrote after it. */
  key(): string {
    return `${ARCHIVE_PREFIX}${this.toString()}`;
  }

  reportableId(): PluginId | null {
    return null;
  }

  toString(): string {
    const at = this.location();
    return this.path === null ? at : `${at}#${this.path}`;
  }
}

export type PluginSource = MarketplaceSource | GithubSource | LocalSource | ArchiveSource;

/** Sources this program was not shipped pointing at - what the trust question is about. */
export type UntrustedSource = GithubSource | LocalSource | ArchiveSource;

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

/** GitHub's view words: `tree` names a folder, these name a file. */
const FILE_VIEWS = new Set(['blob', 'raw', 'blame', 'edit']);

/** Not `packages` or `projects`: both are also what a monorepo calls its folders. */
const REPO_PAGES = new Set([
  'commit',
  'commits',
  'compare',
  'issues',
  'pull',
  'pulls',
  'releases',
  'tags',
  'branches',
  'wiki',
  'actions',
  'discussions',
  'security',
  'settings',
]);

const namesAFile = (spec: string): Failure =>
  new Failure(
    `'${spec}' is a link to a file, not to a plugin.`,
    'Point at the folder that holds it - the .../tree/<ref>/<folder> link GitHub shows for a folder, or owner/repo/folder.',
  );

const notAFolder = (spec: string, segment: string): Failure =>
  new Failure(
    `'${segment}' in '${spec}' is a github.com view, not a folder in the repository.`,
    'Expected owner/repo, owner/repo/folder, or the .../tree/<ref>/<folder> link GitHub shows for a folder.',
  );

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

  // Both patterns consumed the host, so this `@` is a ref, never `git@github.com`.
  const at = rest.lastIndexOf('@');
  if (at > 0 && at < rest.length - 1) {
    inline = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  const segments = rest
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  const [owner, name, ...tail] = segments;
  if (!owner || !name) return err(notARepo(spec));

  let folder = tail;
  const view = url ? tail[0] : undefined;
  if (view === 'tree') {
    // `github.com/acme/mono/tree/v2/tools/foo` - one segment of ref, then the folder.
    if (tail.length < 2) return err(notAFolder(spec, view));
    inline ??= tail[1];
    folder = tail.slice(2);
  } else if (view !== undefined && FILE_VIEWS.has(view)) {
    return err(namesAFile(spec));
  } else if (view !== undefined && REPO_PAGES.has(view)) {
    return err(notAFolder(spec, view));
  }

  const slug = RepoSlug.parse(`${owner}/${name}`);
  if (!slug.ok) return err(notARepo(spec));
  const gitRef = GitRef.parse(inline ?? ref);
  if (!gitRef.ok) return err(gitRef.error);
  const path = repoPath(folder, spec);
  if (!path.ok) return err(path.error);

  return ok(new GithubSource(slug.value.toString(), gitRef.value.toString(), path.value));
}

const HTTP_URL = /^(https?):\/\//i;

/**
 * What the extension is read off: a URL's path, so a presigned link's query
 * does not hide it, and the whole of anything else. `new URL` only where there
 * is a scheme - `C:\dev\p.zip` parses as one, with `c:` for a protocol.
 */
function archiveName(spec: string): string | null {
  if (!HTTP_URL.test(spec)) return spec;
  try {
    return new URL(spec).pathname;
  } catch {
    return null;
  }
}

/**
 * `<archive>#<folder>`, split at the **last** `#` and only when what precedes
 * it is an archive - so `./my#plugin.zip` is a file with a `#` in its name, the
 * way `release/1.0` is a branch with a slash in its. An empty fragment names no
 * folder, and is dropped rather than left on the spec: carried along it put a
 * meaningless `#` in the manifest key a URL is recorded under, and turned
 * `./p.zip#` into a directory of that name, since `formatOf` saw the `#` too.
 */
function splitFragment(spec: string): { at: string; path: string | null } {
  const hash = spec.lastIndexOf('#');
  if (hash <= 0) return { at: spec, path: null };
  const head = spec.slice(0, hash);
  const name = archiveName(head);
  if (name === null || formatOf(name) === null) return { at: spec, path: null };
  return { at: head, path: spec.slice(hash + 1) || null };
}

const bareFile = (spec: string): Failure =>
  new Failure(
    `'${spec}' is a file name, not a plugin id.`,
    `A relative path starts with ./ - write it as ./${spec}, or give the full path.`,
  );

const notHttps = (spec: string): Failure =>
  new Failure(
    `${spec} is not an https URL.`,
    'A plugin can run commands through its hooks, and there is no signature to check, so the connection is the only thing vouching for what arrives. Use https, or download it and install the file.',
  );

function archiveFile(spec: string, { cwd, home, rules }: Required<ParseSourceOptions>): FilePath {
  const expanded =
    spec === '~' ? home : HOME_PREFIXED.test(spec) ? rules.join(home, spec.slice(2)) : spec;
  return new FilePath(rules.resolve(cwd, expanded), rules);
}

/** `null` when the spec is not an archive at all, so the caller reads on. */
function parseArchive(
  spec: string,
  opts: Required<ParseSourceOptions>,
): Result<ArchiveSource, Failure> | null {
  const { at, path } = splitFragment(spec);
  const name = archiveName(at);
  if (name === null || formatOf(name) === null) return null;

  const isUrl = HTTP_URL.test(at);
  // `acme/my-plugin.zip` is still a repository: only a URL or a path can name
  // an archive, which is what keeps every argument this program already took
  // meaning what it did. A bare `my-plugin.zip` is neither, and the id's own
  // failure - "expected kebab-case" - would send the user the wrong way.
  if (!isUrl && !PATH_LIKE.test(at)) return at.includes('/') ? null : err(bareFile(spec));
  if (isUrl && !/^https:/i.test(at)) return err(notHttps(at));

  const folder = path === null ? ok(null) : repoPath(path.split('/').filter(Boolean), spec);
  if (!folder.ok) return err(folder.error);
  const where: ArchiveAt = isUrl
    ? { kind: 'url', url: at }
    : { kind: 'file', file: archiveFile(at, opts) };
  return ok(new ArchiveSource(where, folder.value));
}

export function parseSource(
  spec: unknown,
  { repo, ref, cwd, home, rules = HOST }: ParseSourceOptions,
): Result<PluginSource, Failure> {
  const id = PluginId.parse(spec);
  if (id.ok) return ok(new MarketplaceSource(id.value, repo, ref));
  if (typeof spec !== 'string') return err(id.error);
  const archive = parseArchive(spec, { repo, ref, cwd, home, rules });
  if (archive) return archive;
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
  const archive = archiveOf(repo);
  if (archive) {
    const at: ArchiveAt = HTTP_URL.test(archive.at)
      ? { kind: 'url', url: archive.at }
      : { kind: 'file', file: new FilePath(archive.at, rules) };
    return new ArchiveSource(at, archive.path);
  }
  return new MarketplaceSource(plugin, typeof repo === 'string' ? repo : '', ref);
}

/** The two halves of an archive key, for the row that has to be read back or shown. */
export const archiveOf = (repo: unknown): { at: string; path: string | null } | null =>
  isArchiveKey(repo) ? splitFragment(repo.slice(ARCHIVE_PREFIX.length)) : null;

export const sourceKindOf = (repo: unknown): SourceKind =>
  isLocalKey(repo)
    ? 'local'
    : isGithubKey(repo)
      ? 'github'
      : isArchiveKey(repo)
        ? 'archive'
        : 'marketplace';
