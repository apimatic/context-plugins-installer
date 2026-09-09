// Where the marketplace a run installs from actually lives, in the vocabulary
// `claude plugin marketplace list --json` answers in: today a GitHub
// repository, and - once a plugin can be installed from a path - a directory on
// this machine that we generated.
//
// One value rather than the `marketplace: string | null` and `repo: string`
// pair it replaces. Those travelled side by side from the resolver to the
// harness through two contexts, and nothing stopped a caller passing one
// without the other or a name belonging to a different repository. It is also
// the whole of the Claude harness's policy question - "which name is this filed
// under, and what do I address it by?" - which is why the answer is one type
// rather than two arguments.

/**
 * A marketplace this tool did not create.
 *
 * `name` is what Claude Code filed it under, and it is nullable because that is
 * genuinely unknown on an uninstall whose record carries none: the harness asks
 * the CLI, which may not answer. The repo is what it asks *with*, so that stays
 * required - an origin without one could not be looked up at all.
 *
 * The fields are public, unlike the identifiers in `types/ids/`: this is a
 * value a caller narrows and reads, not a string validated once and thereafter
 * only printed.
 */
export class RepoMarketplace {
  /**
   * The discriminant, on a union that has one arm today. It is here from the
   * start rather than added with the second arm because every narrowing site
   * would otherwise have to be written twice - once without it and once with.
   */
  readonly kind = 'repo' as const;

  constructor(
    readonly repo: string,
    readonly name: string | null = null,
  ) {}

  /**
   * An origin whose marketplace name is already known. The cast is sound by the
   * parameter - `name` cannot be null here - and this is the one place that can
   * say so, which is why registering a marketplace takes one of these rather
   * than an origin and a name that could belong to different marketplaces.
   */
  static named(repo: string, name: string): NamedMarketplace {
    return new RepoMarketplace(repo, name) as NamedMarketplace;
  }

  /**
   * Whether the name is known, narrowing the origin so a caller that has asked
   * does not then have to carry the answer alongside it.
   */
  hasName(): this is this & NamedMarketplace {
    return this.name !== null;
  }

  /**
   * The key a session memoises the registration under. Case-folded on the repo,
   * the way GitHub reads a slug and the way the harness's own listing match
   * already does: two spellings are one marketplace, and registering it twice
   * would be a second `marketplace add` for something already added.
   */
  key(): string {
    return `${this.repo.toLowerCase()}::${this.name ?? ''}`;
  }

  /** What a message calls it, when it has to name where a marketplace came from. */
  describe(): string {
    return this.repo;
  }
}

/**
 * Every place a marketplace can live. A directory arm joins this when `install`
 * learns to take a path; the consumers are written against this name rather
 * than against `RepoMarketplace` so that widening it is one line here and a
 * compile error at each site that has to learn about the new kind.
 */
export type MarketplaceOrigin = RepoMarketplace;

/**
 * An origin Claude Code can be asked to register: every check has run and the
 * name is known. `RepoMarketplace.named` and `hasName` are the only ways to
 * hold one, so a nameless origin cannot reach the code that needs a name.
 */
export type NamedMarketplace = MarketplaceOrigin & { readonly name: string };
