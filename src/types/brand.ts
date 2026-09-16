import { RepoSlug } from './ids/repo-slug.js';
import type { PluginSource } from './plugin-source.js';

// Which marketplace this run installs from, what it calls itself, and whether it
// reports anything. Resolved from a flag, then `CP_*` env, then an rc file, then
// the built-in defaults.

/**
 * The published command name, and the one this CLI calls itself by. Every
 * message that suggests a command interpolates it rather than spelling it out,
 * so `package.json`'s `bin` key is the only other place it appears.
 */
export const BIN = 'context-plugins';

/** The one generated marketplace every plugin installed from a path is filed under. */
export const LOCAL_MARKETPLACE = 'context-plugins-local';

/**
 * Which marketplace a run used, as telemetry may say it: the built-in one by
 * name, or `custom`. Never `brand.repo` - that is user input, and a differently
 * cased spelling of the built-in marketplace is still the built-in one, so the
 * spelling stays on this machine.
 *
 * A class rather than the string it wraps, because an event constructor that
 * took a `string` here would accept `brand.repo` from a caller in a hurry and
 * nothing would fail. `of` is the only way to make one.
 */
export class MarketplaceLabel {
  private constructor(private readonly label: string) {}

  static of(brand: Pick<Brand, 'repo' | 'telemetry'>): MarketplaceLabel {
    const { repo, telemetry } = brand;
    return new MarketplaceLabel(
      RepoSlug.same(repo, telemetry.defaultRepo) ? telemetry.defaultRepo : 'custom',
    );
  }

  static custom(): MarketplaceLabel {
    return new MarketplaceLabel('custom');
  }

  static forSource(
    source: PluginSource | null,
    brand: Pick<Brand, 'repo' | 'telemetry'>,
  ): MarketplaceLabel {
    return source && source.kind !== 'marketplace'
      ? MarketplaceLabel.custom()
      : MarketplaceLabel.of(brand);
  }

  toString(): string {
    return this.label;
  }
}

export const DEFAULTS: Readonly<{
  id: string | null;
  displayName: string;
  repo: string;
  ref: string;
  telemetryToken: string;
  telemetryHost: string;
}> = Object.freeze({
  id: null, // null => read the name from the repo's marketplace.json
  displayName: 'Context Plugins',
  repo: 'context-plugins/plugin-marketplace',
  ref: 'main',
  // A Mixpanel project token is a routing key meant for untrusted clients, not
  // a secret; the project is US-resident, hence the default host.
  telemetryToken: 'c20ead2eb17ee9ae6aad08545e86c00d',
  telemetryHost: 'https://api.mixpanel.com',
});

export interface RcFile {
  repo?: string;
  ref?: string;
  marketplace?: string;
  displayName?: string;
  marketplaceLabel?: string;
  telemetry?: boolean;
}

export interface BrandTelemetry {
  /**
   * Always the project's own, and never absent. It was `string | null` for the
   * brand profiles a caller could once supply; with those gone `resolveBrand`
   * is the only builder and it fills this in from `DEFAULTS`, so "telemetry is
   * not configured" is a state nothing can reach. Whether telemetry runs is
   * decided by the opt-out switches instead.
   */
  readonly token: string;
  readonly host: string;
  /** The marketplace this build ships with; any other --repo is reported as "custom". */
  readonly defaultRepo: string;
  /** `"telemetry": false` in an rc file. */
  readonly rcOptOut: boolean;
}

export interface Brand {
  readonly repo: string;
  readonly ref: string;
  readonly id: string | null;
  readonly displayName: string;
  readonly label: string;
  readonly telemetry: BrandTelemetry;
}
