// Which marketplace this run installs from, what it calls itself, and whether it
// reports anything. Resolved from a flag, then `CP_*` env, then an rc file, then
// the built-in defaults.

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
