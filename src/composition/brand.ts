import * as os from 'node:os';

import { resolveBrand as decideBrand } from '../application/brand-resolution.js';
import { readRc } from '../infrastructure/rc-file.js';
import type { Flags } from '../types/args.js';
import type { Brand } from '../types/brand.js';
import type { Env } from '../types/env.js';
import type { Failure } from '../types/failure.js';
import type { Result } from '../types/result.js';

export interface ResolveBrandOptions {
  flags?: Flags;
  env?: Env;
  cwd?: string;
  home?: string;
}

/**
 * Reads both rc files and hands them to the pure resolver. Reading is
 * infrastructure, deciding is application, and this is the seam that joins
 * them. An rc file the user wrote and this build cannot read is a `Failure`
 * naming the file: the router turns it into exit 2, because it is the command
 * line - broadly read - being wrong rather than the run.
 */
export function readBrand({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
}: ResolveBrandOptions = {}): Result<Brand, Failure> {
  const cwdRc = readRc(cwd);
  if (!cwdRc.ok) return cwdRc;
  const homeRc = readRc(home);
  if (!homeRc.ok) return homeRc;
  return decideBrand({ flags, env, cwdRc: cwdRc.value, homeRc: homeRc.value });
}
