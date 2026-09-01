import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Brand, Env, Flags, Profile, RcFile } from './types.js';
import { UserError, assertRepo, assertRef, stripBom, isPlainObject } from './util.js';

/**
 * Defaults for the marketplace the CLI talks to. Every field can be overridden
 * by a flag, a CP_* environment variable, a .contextpluginsrc file, or a preset
 * profile passed in programmatically.
 */
export const DEFAULT_PROFILE: Readonly<{
  id: string | null;
  displayName: string;
  repo: string;
  ref: string;
  bin: string;
}> = Object.freeze({
  id: null, // marketplace name; null => read it from the repo's marketplace.json
  displayName: 'Context Plugins',
  repo: 'context-plugins/plugin-marketplace',
  ref: 'main',
  bin: 'context-plugins',
});

export const RC_NAME = '.contextpluginsrc';

// The fields resolveBrand reads. Anything else in the file is ignored, so a
// newer version's rc keys do not break an older CLI.
const RC_STRING_FIELDS: readonly (keyof RcFile)[] = [
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
    if (errorCode(err) === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      throw new UserError(`${file} is not valid JSON: ${err.message}`);
    }
    // A file that exists but cannot be read (a directory, permissions) is a
    // problem to report, not configuration to silently skip - proceeding on
    // defaults would install from the wrong marketplace with no message.
    throw new UserError(`Could not read ${file}: ${errorMessage(err)}`);
  }
  // The rc file is user-written configuration, so a wrong shape earns an error
  // that names the file - not an "Invalid repo: 123" three calls later with no
  // hint of where the value came from.
  if (!isPlainObject(parsed)) {
    throw new UserError(`${file} must be a JSON object.`);
  }
  const rc: RcFile = {};
  for (const field of RC_STRING_FIELDS) {
    const value = parsed[field];
    // null is "unset", same as the resolution chain below treats it.
    if (value != null && typeof value !== 'string') {
      throw new UserError(`${file}: '${field}' must be a string.`);
    }
    if (typeof value === 'string') rc[field] = value;
  }
  return rc;
}

/** The first value that is actually set; empty strings count as unset. */
const pick = (...values: (string | null | undefined)[]): string | undefined =>
  values.find((v): v is string => v !== undefined && v !== null && v !== '');

export interface ResolveBrandOptions {
  flags?: Flags;
  profile?: Profile;
  env?: Env;
  cwd?: string;
  home?: string;
}

/**
 * Resolution order (first hit wins):
 *   CLI flag -> env (CP_*) -> .contextpluginsrc (cwd, then home)
 *            -> preset profile -> defaults
 */
export function resolveBrand({
  flags = {},
  profile = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
}: ResolveBrandOptions = {}): Brand {
  const rc = readRc(cwd) || readRc(home) || {};

  const displayName =
    pick(env.CP_DISPLAY_NAME, rc.displayName, profile.displayName) ?? DEFAULT_PROFILE.displayName;

  const brand: Brand = {
    repo: assertRepo(pick(flags.repo, env.CP_REPO, rc.repo, profile.repo) ?? DEFAULT_PROFILE.repo),
    ref: assertRef(pick(flags.ref, env.CP_REF, rc.ref, profile.ref) ?? DEFAULT_PROFILE.ref),
    id:
      pick(flags.marketplace, env.CP_MARKETPLACE, rc.marketplace, profile.id) ?? DEFAULT_PROFILE.id,
    displayName,
    // What the user sees in place of the repository. The repository is an
    // implementation detail of where plugins are stored.
    label:
      pick(env.CP_MARKETPLACE_LABEL, rc.marketplaceLabel, profile.label) ??
      `${displayName} Marketplace`,
    bin: pick(profile.bin) ?? DEFAULT_PROFILE.bin,
  };

  return Object.freeze(brand);
}
