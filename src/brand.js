'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserError, assertRepo, assertRef, stripBom } = require('./util');

/**
 * Nothing here names a vendor. `apimatic` is not a constant anywhere in this
 * package - it is only ever a value someone supplies (flag, env, rc file, or a
 * brand wrapper package), which is what makes the CLI whitelabel-safe.
 */
const DEFAULT_PROFILE = Object.freeze({
  id: null, // marketplace name; null => derive from the repo's marketplace.json
  displayName: 'Context Plugins',
  repo: 'context-plugins/plugin-marketplace',
  ref: 'main',
  bin: 'context-plugins',
});

const RC_NAME = '.contextpluginsrc';

function readRc(dir) {
  if (!dir) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(path.join(dir, RC_NAME), 'utf8')));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      throw new UserError(`${path.join(dir, RC_NAME)} is not valid JSON: ${err.message}`);
    }
    return null;
  }
}

const firstSet = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

/**
 * Resolution order (first hit wins):
 *   CLI flag -> env (CP_*) -> .contextpluginsrc (cwd, then home)
 *            -> wrapper profile -> neutral defaults
 */
function resolveBrand({
  flags = {},
  profile = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
} = {}) {
  const rc = readRc(cwd) || readRc(home) || {};

  const brand = {
    repo: firstSet(flags.repo, env.CP_REPO, rc.repo, profile.repo, DEFAULT_PROFILE.repo),
    ref: firstSet(flags.ref, env.CP_REF, rc.ref, profile.ref, DEFAULT_PROFILE.ref),
    id:
      firstSet(
        flags.marketplace,
        env.CP_MARKETPLACE,
        rc.marketplace,
        profile.id,
        DEFAULT_PROFILE.id,
      ) || null,
    displayName: firstSet(
      env.CP_DISPLAY_NAME,
      rc.displayName,
      profile.displayName,
      DEFAULT_PROFILE.displayName,
    ),
    bin: firstSet(profile.bin, DEFAULT_PROFILE.bin),
  };

  assertRepo(brand.repo);
  assertRef(brand.ref);
  return Object.freeze(brand);
}

module.exports = { DEFAULT_PROFILE, RC_NAME, resolveBrand, readRc };
