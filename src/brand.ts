import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Brand, Env, Flags, Profile, RcFile } from './types.js';
import { UserError, assertRepo, assertRef, stripBom, isPlainObject } from './util.js';

export const DEFAULT_PROFILE: Readonly<{
  id: string | null;
  displayName: string;
  repo: string;
  ref: string;
  bin: string;
  telemetryToken: string | null;
  telemetryHost: string;
}> = Object.freeze({
  id: null, // null => read the name from the repo's marketplace.json
  displayName: 'Context Plugins',
  repo: 'context-plugins/plugin-marketplace',
  ref: 'main',
  bin: 'context-plugins',
  // A Mixpanel project token is a routing key meant for untrusted clients, not
  // a secret; the project is US-resident, hence the default host.
  telemetryToken: 'c20ead2eb17ee9ae6aad08545e86c00d',
  telemetryHost: 'https://api.mixpanel.com',
});

export const RC_NAME = '.contextpluginsrc';

type RcStringField = Exclude<keyof RcFile, 'telemetry'>;

// Unknown rc keys are ignored, so a newer version's file does not break an older CLI.
const RC_STRING_FIELDS: readonly RcStringField[] = [
  'repo',
  'ref',
  'marketplace',
  'displayName',
  'marketplaceLabel',
];

const errorCode = (err: unknown): unknown =>
  err instanceof Error && 'code' in err ? err.code : undefined;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function readRc(dir: string | undefined): RcFile | null {
  if (!dir) return null;
  const file = path.join(dir, RC_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    // ENOTDIR means a component of the path is a file, so no rc file can exist
    // there - the same proof of absence ENOENT gives. Both are "carry on".
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null;
    if (err instanceof SyntaxError) {
      throw new UserError(`${file} is not valid JSON: ${err.message}`);
    }
    // A file that may well be there and cannot be read (a directory, a
    // permission wall) must not fall back to defaults silently: that would
    // install from the wrong marketplace.
    throw new UserError(`Could not read ${file}: ${errorMessage(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new UserError(`${file} must be a JSON object.`);
  }
  const rc: RcFile = {};
  for (const field of RC_STRING_FIELDS) {
    const value = parsed[field];
    // null means unset, as the resolution chain below treats it.
    if (value != null && typeof value !== 'string') {
      throw new UserError(`${file}: '${field}' must be a string.`);
    }
    if (typeof value === 'string') rc[field] = value;
  }
  if (parsed.telemetry != null) {
    if (typeof parsed.telemetry !== 'boolean') {
      throw new UserError(`${file}: 'telemetry' must be true or false.`);
    }
    rc.telemetry = parsed.telemetry;
  }
  return rc;
}

/** The first value that is set; empty strings count as unset. */
const pick = (...values: (string | null | undefined)[]): string | undefined =>
  values.find((v): v is string => v !== undefined && v !== null && v !== '');

export interface ResolveBrandOptions {
  flags?: Flags;
  profile?: Profile;
  env?: Env;
  cwd?: string;
  home?: string;
}

// Resolution order: flag -> CP_* env -> rc (cwd, then home) -> profile -> defaults.
export function resolveBrand({
  flags = {},
  profile = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
}: ResolveBrandOptions = {}): Brand {
  // Both files are read: the first found sets the defaults, but an opt-out in
  // either is honoured, or a project rc that only names a repo would silence the
  // one in the home directory.
  const cwdRc = readRc(cwd);
  const homeRc = readRc(home);
  const rc = cwdRc || homeRc || {};

  const displayName =
    pick(env.CP_DISPLAY_NAME, rc.displayName, profile.displayName) ?? DEFAULT_PROFILE.displayName;

  // Telemetry is the brand's to configure and the user's to refuse. A brand with
  // its own marketplace opts in by naming a token: the default token belongs to
  // this project, and must not collect on another's behalf. The env switches are
  // read where the event is sent.
  const ownRepo = pick(profile.repo);
  const inherits = !ownRepo || ownRepo === DEFAULT_PROFILE.repo;
  const telemetry = Object.freeze({
    token:
      profile.telemetryToken === undefined
        ? inherits
          ? DEFAULT_PROFILE.telemetryToken
          : null
        : profile.telemetryToken || null,
    host: pick(profile.telemetryHost) ?? DEFAULT_PROFILE.telemetryHost,
    defaultRepo: assertRepo(ownRepo ?? DEFAULT_PROFILE.repo),
    rcOptOut: cwdRc?.telemetry === false || homeRc?.telemetry === false,
  });

  const brand: Brand = {
    repo: assertRepo(pick(flags.repo, env.CP_REPO, rc.repo, profile.repo) ?? DEFAULT_PROFILE.repo),
    ref: assertRef(pick(flags.ref, env.CP_REF, rc.ref, profile.ref) ?? DEFAULT_PROFILE.ref),
    id:
      pick(flags.marketplace, env.CP_MARKETPLACE, rc.marketplace, profile.id) ?? DEFAULT_PROFILE.id,
    displayName,
    label:
      pick(env.CP_MARKETPLACE_LABEL, rc.marketplaceLabel, profile.label) ??
      `${displayName} Marketplace`,
    bin: pick(profile.bin) ?? DEFAULT_PROFILE.bin,
    telemetry,
  };

  return Object.freeze(brand);
}
