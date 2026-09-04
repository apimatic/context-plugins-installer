import * as os from 'node:os';

import type { Flags } from './types/args.js';
import { readRc } from './infrastructure/rc-file.js';
import type { Brand } from './types/brand.js';
import type { Env } from './types/env.js';
import { assertRepo, assertRef, orThrow } from './util.js';

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
  telemetryToken: string | null;
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

/** The first value that is set; empty strings count as unset. */
const pick = (...values: (string | null | undefined)[]): string | undefined =>
  values.find((v): v is string => v !== undefined && v !== null && v !== '');

export interface ResolveBrandOptions {
  flags?: Flags;
  env?: Env;
  cwd?: string;
  home?: string;
}

// Resolution order: flag -> CP_* env -> rc (cwd, then home) -> defaults.
export function resolveBrand({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
}: ResolveBrandOptions = {}): Brand {
  // Both files are read, and merged field by field rather than one winning
  // whole. Taking the first found meant a project rc that set only `telemetry`
  // discarded the home rc's marketplace and installed from the built-in one
  // without saying so. An opt-out in either file is still honoured on its own.
  const cwdRc = orThrow(readRc(cwd));
  const homeRc = orThrow(readRc(home));
  const rc = { ...homeRc, ...cwdRc };

  const displayName = pick(env.CP_DISPLAY_NAME, rc.displayName) ?? DEFAULTS.displayName;

  // Telemetry is this project's to configure and the user's to refuse. The
  // switches that refuse it are read where the event is sent, not here.
  const telemetry = Object.freeze({
    token: DEFAULTS.telemetryToken,
    host: DEFAULTS.telemetryHost,
    defaultRepo: assertRepo(DEFAULTS.repo),
    rcOptOut: cwdRc?.telemetry === false || homeRc?.telemetry === false,
  });

  const brand: Brand = {
    repo: assertRepo(pick(flags.repo, env.CP_REPO, rc.repo) ?? DEFAULTS.repo),
    ref: assertRef(pick(flags.ref, env.CP_REF, rc.ref) ?? DEFAULTS.ref),
    id: pick(flags.marketplace, env.CP_MARKETPLACE, rc.marketplace) ?? DEFAULTS.id,
    displayName,
    label: pick(env.CP_MARKETPLACE_LABEL, rc.marketplaceLabel) ?? `${displayName} Marketplace`,
    telemetry,
  };

  return Object.freeze(brand);
}
