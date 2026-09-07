import * as os from 'node:os';

import { resolveBrand as decideBrand } from './application/brand-resolution.js';
import { readRc } from './infrastructure/rc-file.js';
import type { Flags } from './types/args.js';
import type { Brand } from './types/brand.js';
import type { Env } from './types/env.js';
import { orThrow } from './util.js';

export interface ResolveBrandOptions {
  flags?: Flags;
  env?: Env;
  cwd?: string;
  home?: string;
}

/**
 * Reads both rc files and hands them to the pure resolver. Reading is
 * infrastructure, deciding is application, and this is the seam that joins
 * them - throwing the way its callers still expect - until Phase 6's router
 * owns both halves.
 */
export function resolveBrand({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
}: ResolveBrandOptions = {}): Brand {
  const cwdRc = orThrow(readRc(cwd));
  const homeRc = orThrow(readRc(home));
  return orThrow(decideBrand({ flags, env, cwdRc, homeRc }));
}
