import { Failure } from '../failure.js';
import { err, ok, type Result } from '../result.js';

// Refs are passed to git as argv, so anything that could read as an option is
// refused: the leading character must be alphanumeric.
const PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA = /^[0-9a-f]{7,40}$/i;

export class GitRef {
  /** For callers holding an already-validated ref; anything else uses `parse`. */
  constructor(private readonly ref: string) {}

  static parse(value: unknown): Result<GitRef, Failure> {
    if (typeof value !== 'string' || !PATTERN.test(value)) {
      return err(
        new Failure(
          `Invalid ref: ${JSON.stringify(value)}`,
          'Expected a branch, tag, or commit sha, e.g. main',
        ),
      );
    }
    return ok(new GitRef(value));
  }

  /** undefined rather than a reason, for callers that only need to know. */
  static create(value: unknown): GitRef | undefined {
    const parsed = GitRef.parse(value);
    return parsed.ok ? parsed.value : undefined;
  }

  /** A commit sha, which `git clone --branch` will not accept. */
  isSha(): boolean {
    return SHA.test(this.ref);
  }

  isEqual(other: GitRef): boolean {
    return this.ref === other.ref;
  }

  toString(): string {
    return this.ref;
  }
}
