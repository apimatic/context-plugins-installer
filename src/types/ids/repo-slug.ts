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

  /**
   * The API's view of the file `rawUrl` names, for when the raw CDN is having
   * an outage of its own. Asked for with the raw media type it serves the
   * bytes verbatim, so a caller reads the same body from either host.
   *
   * Encoded, unlike `rawUrl`: here the path is a segment of an API route and
   * the ref is a query parameter, so a space or a `#` in either has to arrive
   * as an escape rather than as punctuation.
   */
  contentsUrl(ref: string, filePath: string): string {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${this.slug}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  }

  treeUrl(ref: string): string {
    return `https://api.github.com/repos/${this.slug}/git/trees/${ref}?recursive=1`;
  }

  /** Case-insensitive, because GitHub treats an owner and a name that way. */
  matches(other: RepoSlug): boolean {
    return this.slug.toLowerCase() === other.slug.toLowerCase();
  }

  /**
   * Whether two recorded spellings name the same repository. Untrusted values
   * on purpose: this compares what a manifest row, a flag and a registry say,
   * and none of those is a `RepoSlug` yet - a row on disk may hold anything at
   * all. Case-insensitive for exactly the reason `matches` is, so the two
   * halves of a run cannot disagree about it; anything that is not a pair of
   * strings falls back to the identity the callers used before.
   */
  static same(a: unknown, b: unknown): boolean {
    if (typeof a === 'string' && typeof b === 'string') {
      return a.toLowerCase() === b.toLowerCase();
    }
    const key = (v: unknown): unknown => (v === undefined || v === null || v === '' ? '' : v);
    return key(a) === key(b);
  }

  /** Lower-cased, for the callers that search text for a mention of this repo. */
  toSearchKey(): string {
    return this.slug.toLowerCase();
  }

  toString(): string {
    return this.slug;
  }
}
