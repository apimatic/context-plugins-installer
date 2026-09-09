import type { Flags } from '../types/args.js';
import { DEFAULTS, type Brand, type RcFile } from '../types/brand.js';
import type { Env } from '../types/env.js';
import type { Failure } from '../types/failure.js';
import { GitRef } from '../types/ids/git-ref.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import { err, ok, type Result } from '../types/result.js';

// Which marketplace a run installs from: flag -> CP_* env -> rc (cwd, then
// home) -> the built-in defaults. Pure, over rc files something else has
// already read, because reading them can fail in ways only their reader can
// describe and this has nothing useful to add to that.

/** The first value that is set; empty strings count as unset. */
const pick = (...values: (string | null | undefined)[]): string | undefined =>
  values.find((v): v is string => v !== undefined && v !== null && v !== '');

export interface BrandSources {
  flags?: Flags;
  env: Env;
  /** `.contextpluginsrc` in the working directory, and in the home directory. */
  cwdRc?: RcFile | null;
  homeRc?: RcFile | null;
}

export function resolveBrand({
  flags = {},
  env,
  cwdRc = null,
  homeRc = null,
}: BrandSources): Result<Brand, Failure> {
  // Both files are merged field by field rather than one winning whole. Taking
  // the first found meant a project rc that set only `telemetry` discarded the
  // home rc's marketplace and installed from the built-in one without saying
  // so. An opt-out in either file is still honoured on its own.
  const rc = { ...homeRc, ...cwdRc };

  const repo = RepoSlug.parse(pick(flags.repo, env.CP_REPO, rc.repo) ?? DEFAULTS.repo);
  if (!repo.ok) return err(repo.error);
  const ref = GitRef.parse(pick(flags.ref, env.CP_REF, rc.ref) ?? DEFAULTS.ref);
  if (!ref.ok) return err(ref.error);
  // The one repo that is not user input; parsed anyway, so a bad edit to the
  // constant fails here rather than at the first URL built from it.
  const defaultRepo = RepoSlug.parse(DEFAULTS.repo);
  if (!defaultRepo.ok) return err(defaultRepo.error);

  const displayName = pick(env.CP_DISPLAY_NAME, rc.displayName) ?? DEFAULTS.displayName;

  // Telemetry is this project's to configure and the user's to refuse. The
  // switches that refuse it are read where the event is sent, not here.
  const telemetry = Object.freeze({
    token: DEFAULTS.telemetryToken,
    host: DEFAULTS.telemetryHost,
    defaultRepo: defaultRepo.value.toString(),
    rcOptOut: cwdRc?.telemetry === false || homeRc?.telemetry === false,
  });

  return ok(
    Object.freeze({
      repo: repo.value.toString(),
      ref: ref.value.toString(),
      id: pick(flags.marketplace, env.CP_MARKETPLACE, rc.marketplace) ?? DEFAULTS.id,
      displayName,
      label: pick(env.CP_MARKETPLACE_LABEL, rc.marketplaceLabel) ?? `${displayName} Marketplace`,
      telemetry,
    }),
  );
}
