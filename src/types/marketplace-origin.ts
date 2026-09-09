import type { DirectoryPath } from './file/paths.js';
import { MarketplaceName } from './ids/marketplace-name.js';
import { nonEmptyString } from './util.js';

// Where the marketplace a run installs from actually lives, in the vocabulary
// `claude plugin marketplace list --json` answers in: a GitHub repository, or a
// directory on this machine - which for now means the one this tool generates
// for plugins that came from a path.
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
  readonly kind = 'repo' as const;

  constructor(
    readonly repo: string,
    readonly name: string | null = null,
  ) {}

  /**
   * An origin whose marketplace name is already known. It takes the validated
   * `MarketplaceName` rather than a string, so the claim the return type makes
   * is carried by the argument: a name that got this far passed the pattern and
   * cannot be empty. Nothing here re-checks it - a caller holding one has
   * already paid for that.
   */
  static named(repo: string, name: MarketplaceName): NamedMarketplace {
    return new RepoMarketplace(repo, name.toString()) as NamedMarketplace;
  }

  /**
   * Whether the name is known, narrowing the origin so a caller that has asked
   * does not then have to carry the answer alongside it.
   *
   * `nonEmptyString` rather than a null check, because that is the question
   * every other reader of a marketplace name asks - the harness reads Claude's
   * own listing that way twice. An empty name passing here would clear the
   * install's guard and then be spelled into `plugin install <id>@`.
   */
  hasName(): this is this & NamedMarketplace {
    return nonEmptyString(this.name);
  }

  /**
   * The key a session memoises the registration under. In memory, for one run,
   * so the format is ours to choose - and two things it has to hold. The repo
   * is case-folded the way GitHub reads a slug, so two spellings of one
   * repository register once rather than twice. And the discriminant leads, so
   * a second kind of origin cannot fold into a repo's key and be handed that
   * repo's cached registration: `session.marketplaces` is a `Map<string, ...>`,
   * and there is nothing narrower to catch it.
   *
   * The name is *not* folded, deliberately. Claude Code keys a marketplace by
   * the name it was added under, and this build has no evidence that it reads
   * two spellings of one name as one marketplace.
   */
  key(): string {
    return `${this.kind}:${this.repo.toLowerCase()}::${this.name ?? ''}`;
  }

  /** The display route, the way every other value in `types/` spells its own. */
  toString(): string {
    return this.repo;
  }
}

/**
 * A marketplace directory, which `claude plugin marketplace add` takes as a
 * source just as it takes a repository. This tool generates one, so unlike a
 * repository's the name is never unknown: we chose it before the directory
 * existed, which is why `name` is a plain `string` here and every instance is
 * already a `NamedMarketplace`.
 */
export class DirectoryMarketplace {
  readonly kind = 'directory' as const;

  constructor(
    readonly dir: DirectoryPath,
    readonly name: string,
  ) {}

  /**
   * Case-folded like the repo arm's, and for the same reason on the two
   * platforms where a path's case does not distinguish directories. The
   * discriminant leads, so this can never collide with a slug's key.
   */
  key(): string {
    return `${this.kind}:${this.dir.toString().toLowerCase()}`;
  }

  /** Always: we named this one. Here so a caller can ask the union. */
  hasName(): this is this & NamedMarketplace {
    return nonEmptyString(this.name);
  }

  toString(): string {
    return this.dir.toString();
  }
}

/**
 * Every place a marketplace can live. The consumers are written against this
 * name rather than against either class, so a third kind is one line here and a
 * compile error at each site that has to learn about it.
 */
export type MarketplaceOrigin = RepoMarketplace | DirectoryMarketplace;

/**
 * An origin Claude Code can be asked to register: every check has run and the
 * name is known. `RepoMarketplace.named` and `hasName` are the only ways to
 * hold one, so a nameless origin cannot reach the code that needs a name.
 *
 * An intersection rather than a second class, and not the branded alias the
 * value-object rules refuse: a brand is erased at runtime and cannot carry
 * behaviour, where this keeps every method the class has and only narrows a
 * field.
 */
export type NamedMarketplace = MarketplaceOrigin & { readonly name: string };
