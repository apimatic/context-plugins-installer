import type { DirectoryPath } from './file/paths.js';
import { MarketplaceName } from './ids/marketplace-name.js';
import { nonEmptyString } from './util.js';

// Where the marketplace a run installs from lives, in the vocabulary
// `claude plugin marketplace list --json` answers in.

/** `name` is null when nothing has named it: an uninstall whose record carries none. */
export class RepoMarketplace {
  readonly kind = 'repo' as const;

  constructor(
    readonly repo: string,
    readonly name: string | null = null,
  ) {}

  static named(repo: string, name: MarketplaceName): NamedMarketplace {
    return new RepoMarketplace(repo, name.toString()) as NamedMarketplace;
  }

  // `nonEmptyString` rather than a null check: an empty name would clear this
  // guard and then be spelled into `plugin install <id>@`.
  hasName(): this is this & NamedMarketplace {
    return nonEmptyString(this.name);
  }

  // Repo case-folded the way GitHub reads a slug; the discriminant leads so two
  // kinds of origin cannot collide on one key.
  key(): string {
    return `${this.kind}:${this.repo.toLowerCase()}::${this.name ?? ''}`;
  }

  toString(): string {
    return this.repo;
  }
}

/** The marketplace this tool generates for plugins installed from a path. */
export class DirectoryMarketplace {
  readonly kind = 'directory' as const;

  constructor(
    readonly dir: DirectoryPath,
    readonly name: string,
  ) {}

  key(): string {
    return `${this.kind}:${this.dir.toString().toLowerCase()}`;
  }

  hasName(): this is this & NamedMarketplace {
    return nonEmptyString(this.name);
  }

  toString(): string {
    return this.dir.toString();
  }
}

export type MarketplaceOrigin = RepoMarketplace | DirectoryMarketplace;

/** `RepoMarketplace.named` and `hasName` are the only ways to hold one. */
export type NamedMarketplace = MarketplaceOrigin & { readonly name: string };
