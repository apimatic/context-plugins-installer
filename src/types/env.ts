// How a run sees the machine it is on. `paths.ts` resolves against these rather
// than reading `process` directly, which is what lets a test describe another
// platform's machine and assert its paths from this one.

export type Env = Record<string, string | undefined>;

/** `platform` selects the *target* platform's path rules, not the host's. */
export interface PathOpts {
  platform?: string;
  env?: Env;
  home?: string;
}
