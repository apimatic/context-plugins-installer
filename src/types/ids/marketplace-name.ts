// Claude Code's marketplace schema: kebab-case identifier, no spaces. Checked
// where the registry is read, because otherwise the failure surfaces much later
// as a bare "plugin not found" from the `claude` CLI.
const PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

export class MarketplaceName {
  /** For callers holding an already-validated name; anything else uses `create`. */
  constructor(private readonly name: string) {}

  static create(value: unknown): MarketplaceName | undefined {
    return typeof value === 'string' && PATTERN.test(value)
      ? new MarketplaceName(value)
      : undefined;
  }

  /**
   * The rule in prose. Callers word their own message around it, because what
   * to do about a bad name depends on where the name came from.
   */
  static readonly RULE = 'kebab-case with no spaces';

  toString(): string {
    return this.name;
  }
}
