import { Failure } from '../failure.js';
import { err, ok, type Result } from '../result.js';

const PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// A repo reaches us spelled several ways: Claude's marketplace listing has
// carried it as a bare slug, an https URL and an scp-style git address, with and
// without the `.git` suffix.
const IN_TEXT = /(?:github\.com[/:]|^)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;

/** `owner/name` on GitHub, and the one place the URLs built from it are spelled. */
export class RepoSlug {
  /** For callers holding an already-validated slug; anything else uses `parse`. */
  constructor(private readonly slug: string) {}

  static parse(value: unknown): Result<RepoSlug, Failure> {
    if (typeof value !== 'string' || !PATTERN.test(value)) {
      return err(
        new Failure(
          `Invalid repo: ${JSON.stringify(value)}`,
          'Expected owner/repo, e.g. acme/plugin-marketplace',
        ),
      );
    }
    return ok(new RepoSlug(value));
  }

  /** undefined rather than a reason, for callers that only need to know. */
  static create(value: unknown): RepoSlug | undefined {
    const parsed = RepoSlug.parse(value);
    return parsed.ok ? parsed.value : undefined;
  }

  /** The slug inside a field that may spell it as a URL or a git address. */
  static fromText(text: unknown): RepoSlug | undefined {
    if (!text) return undefined;
    const hit = String(text).trim().match(IN_TEXT);
    // Through `create`, so the class has one definition of validity and the
    // path that reads untrusted text is the one that uses it.
    return hit?.[1] ? RepoSlug.create(hit[1]) : undefined;
  }

  cloneUrl(): string {
    return `https://github.com/${this.slug}.git`;
  }

  rawUrl(ref: string, filePath: string): string {
    return `https://raw.githubusercontent.com/${this.slug}/${ref}/${filePath}`;
  }

  treeUrl(ref: string): string {
    return `https://api.github.com/repos/${this.slug}/git/trees/${ref}?recursive=1`;
  }

  /** Case-insensitive, because GitHub treats an owner and a name that way. */
  matches(other: RepoSlug): boolean {
    return this.slug.toLowerCase() === other.slug.toLowerCase();
  }

  /** Lower-cased, for the callers that search text for a mention of this repo. */
  toSearchKey(): string {
    return this.slug.toLowerCase();
  }

  toString(): string {
    return this.slug;
  }
}
