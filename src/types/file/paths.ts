import * as nodePath from 'node:path';

// Both classes live in one module on purpose: a directory builds a file path and
// a file path names its directory, so splitting them would either need a runtime
// import cycle or expose the joining rules that are nobody else's business.

/**
 * The joining rules of the platform a path belongs to, which is not always the
 * platform we are running on. `paths.ts` picks these from the requested target,
 * and that is what lets the suite assert a Windows path from a Linux runner.
 */
export type PathRules = Pick<typeof nodePath, 'join' | 'dirname' | 'basename' | 'sep'>;

export const rulesFor = (platform: string): PathRules =>
  platform === 'win32' ? nodePath.win32 : nodePath.posix;

/**
 * Either kind of path, or a plain string still on its way to being one. The
 * string arm is transitional: it lets a helper take a path from a caller that
 * has not been converted yet, and Phase 2's file-system service drops it.
 */
export type PathArg = DirectoryPath | FilePath | string;

export const pathString = (value: PathArg): string =>
  typeof value === 'string' ? value : value.toString();

export class DirectoryPath {
  constructor(
    private readonly dir: string,
    private readonly rules: PathRules = nodePath,
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

  leafName(): string {
    return this.rules.basename(this.dir);
  }

  isEqual(other: DirectoryPath): boolean {
    return this.dir === other.dir;
  }

  /**
   * Whether `target` is this directory or sits inside it. The separator matters:
   * without it `/tmp/files` would look like it contained `/tmp/files-elsewhere`.
   */
  contains(target: PathArg): boolean {
    const inner = pathString(target);
    return inner === this.dir || inner.startsWith(this.dir + this.rules.sep);
  }

  toString(): string {
    return this.dir;
  }
}

export class FilePath {
  constructor(
    private readonly file: string,
    private readonly rules: PathRules = nodePath,
  ) {}

  parent(): DirectoryPath {
    return new DirectoryPath(this.rules.dirname(this.file), this.rules);
  }

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
}
