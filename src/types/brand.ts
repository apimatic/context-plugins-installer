// Which marketplace this run installs from, what it calls itself, and whether it
// reports anything. Resolved from a flag, then `CP_*` env, then an rc file, then
// the built-in defaults.

/**
 * The published command name, and the one this CLI calls itself by. Every
 * message that suggests a command interpolates it rather than spelling it out,
 * so `package.json`'s `bin` key is the only other place it appears.
 */
export const BIN = 'context-plugins';

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
   * null means telemetry is not configured, so nothing is sent. Nothing in a
   * real run produces it any more: with brand profiles gone, `resolveBrand`
   * always fills the token in, and only a Brand built by hand in a test is
   * null. The branch it feeds in telemetry.ts is therefore reachable from
   * tests alone - see the Phase 3 note in docs/layering-plan.md, which decides
   * whether to narrow this to `string` and delete that branch with it.
   */
  readonly token: string | null;
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
