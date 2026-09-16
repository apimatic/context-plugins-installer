import * as nodePath from 'node:path';

// Both classes live in one module on purpose: a directory builds a file path and
// a file path names its directory, so splitting them would either need a runtime
// import cycle or expose the joining rules that are nobody else's business.

/**
 * The joining rules of the platform a path belongs to, which is not always the
 * platform we are running on. `paths.ts` picks these from the requested target,
 * and that is what lets the suite assert a Windows path from a Linux runner.
 */
export interface PathRules {
  join(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string): string;
  normalize(p: string): string;
  /** Always called with an explicit base first: a bare `resolve` reads the host's own cwd. */
  resolve(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;
}

/**
 * A plain object rather than `nodePath.win32` itself. Node's path namespaces
 * carry `.win32` and `.posix` back-references, so holding one would make every
 * path value circular and `JSON.stringify` of any of them throw. The methods are
 * bound so detaching them from the namespace stays safe.
 */
const extract = (rules: typeof nodePath): PathRules => ({
  join: rules.join.bind(rules),
  dirname: rules.dirname.bind(rules),
  basename: rules.basename.bind(rules),
  normalize: rules.normalize.bind(rules),
  resolve: rules.resolve.bind(rules),
  isAbsolute: rules.isAbsolute.bind(rules),
  sep: rules.sep,
});

const WIN32 = extract(nodePath.win32);
const POSIX = extract(nodePath.posix);

/** This machine's rules, for a path that is a real path on this machine. */
export const HOST: PathRules = extract(nodePath);

export const rulesFor = (platform: string): PathRules => (platform === 'win32' ? WIN32 : POSIX);

/**
 * A path, or a plain string that is one. The two aliases are separate so a
 * helper that needs a directory cannot silently be handed a file.
 *
 * The string arm was meant to be transitional and is not: measured by narrowing
 * both aliases and compiling, it is load-bearing in two places and nowhere else.
 * An fs module hands itself a host string - `ensureDirFor` passing `dirname` to
 * `ensureDir`, `copyDir` and `countFiles` recursing, the fetcher's temp
 * workspace - and an fs boundary is exactly where a path becomes a string.
 * `f.path` takes whatever is about to be shown, which includes strings that were
 * never paths at all: `which('git')`'s answer, and a harness `location()` that
 * describes `$PATH` rather than naming a directory.
 *
 * What it is *not* for is carrying a path between layers, which is how the
 * plugin source used to reach a harness as a bare string. Nothing in `types/`
 * spells a machine path as a string now, so the arm has no way to spread.
 */
export type DirArg = DirectoryPath | string;
export type FileArg = FilePath | string;
export type PathArg = DirArg | FileArg;

export const pathString = (value: PathArg): string =>
  typeof value === 'string' ? value : value.toString();

export class DirectoryPath {
  constructor(
    private readonly dir: string,
    private readonly rules: PathRules = HOST,
  ) {}

  join(...parts: string[]): DirectoryPath {
    return new DirectoryPath(this.rules.join(this.dir, ...parts), this.rules);
  }

  file(...parts: string[]): FilePath {
    return new FilePath(this.rules.join(this.dir, ...parts), this.rules);
  }

  parent(): DirectoryPath {
    return new DirectoryPath(this.rules.dirname(this.dir), this.rules);
  }

  isEqual(other: DirectoryPath): boolean {
    return this.dir === other.dir;
  }

  /** Normalized and stripped of any trailing separator, so the two are comparable. */
  private settled(value: string): string {
    const normalized = this.rules.normalize(value);
    let end = normalized.length;
    while (end > 0 && normalized[end - 1] === this.rules.sep) end -= 1;
    return normalized.slice(0, end);
  }

  /**
   * Whether `target` is this directory or sits inside it - the guard on a write
   * named by a remote tree entry, so it errs towards refusing.
   *
   * Both sides are normalized, so a `..` is collapsed here rather than trusted
   * to have been collapsed by whoever built the target. Both are also stripped
   * of a trailing separator: `normalize` keeps one on a UNC root and on any
   * directory the user wrote with one, and `outer + sep` then matched nothing at
   * all. The separator still matters in the comparison itself - without it
   * `/tmp/files` would look like it contained `/tmp/files-elsewhere`.
   *
   * Both paths must be of the same kind. Comparing a relative path with an
   * absolute one answers false, because nothing here knows what the relative
   * one is relative to.
   */
  contains(target: PathArg): boolean {
    const inner = this.settled(pathString(target));
    const outer = this.settled(this.dir);
    return inner === outer || inner.startsWith(outer + this.rules.sep);
  }

  /**
   * Case-folded under Windows rules only, so it under-matches on a
   * case-insensitive macOS filesystem: nothing here can tell darwin from linux.
   */
  samePlace(other: PathArg): boolean {
    const windows = this.rules.sep !== '/';
    const fold = (value: string): string => (windows ? value.toLowerCase() : value);
    return fold(this.settled(pathString(other))) === fold(this.settled(this.dir));
  }

  /**
   * Same directory or one inside the other, case folded whatever the platform:
   * this guards a copy against eating its own source, so it errs at over-matching.
   */
  overlaps(other: DirectoryPath): boolean {
    const sep = this.rules.sep;
    const a = this.settled(this.dir).toLowerCase();
    const b = this.settled(other.toString()).toLowerCase();
    return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  }

  toString(): string {
    return this.dir;
  }

  /**
   * A path is worth exactly its string on the wire. Without this, the rules
   * object rides along and a payload gets `{"dir":...}` where it wanted a path -
   * silently, since making the rules serializable also removed the crash that
   * used to catch it.
   */
  toJSON(): string {
    return this.dir;
  }
}

export class FilePath {
  constructor(
    private readonly file: string,
    private readonly rules: PathRules = HOST,
  ) {}

  parent(): DirectoryPath {
    return new DirectoryPath(this.rules.dirname(this.file), this.rules);
  }

  /** The file's own name, by its own rules: a host `basename` would not do. */
  name(): string {
    return this.rules.basename(this.file);
  }

  /** A sibling whose name carries a suffix: the settings backup, the temp write. */
  withSuffix(suffix: string): FilePath {
    return new FilePath(this.file + suffix, this.rules);
  }

  isEqual(other: FilePath): boolean {
    return this.file === other.file;
  }

  toString(): string {
    return this.file;
  }

  /** As with a directory: a file path is worth its string, and nothing else. */
  toJSON(): string {
    return this.file;
  }
}

/** A FilePath from either form; a plain string is taken as a path on this machine. */
export const asFilePath = (value: FileArg): FilePath =>
  typeof value === 'string' ? new FilePath(value) : value;
