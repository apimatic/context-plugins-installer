'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserError, assertRepo, assertRef, stripBom } = require('./util');

/**
 * Defaults for the marketplace the CLI talks to. Every field can be overridden
 * by a flag, a CP_* environment variable, a .contextpluginsrc file, or a preset
 * profile passed in programmatically.
 */
const DEFAULT_PROFILE = Object.freeze({
  id: null, // marketplace name; null => read it from the repo's marketplace.json
  displayName: 'Context Plugins',
  repo: 'context-plugins/plugin-marketplace',
  ref: 'main',
  bin: 'context-plugins',
});

const RC_NAME = '.contextpluginsrc';

// The fields resolveBrand reads. Anything else in the file is ignored, so a
// newer version's rc keys do not break an older CLI.
const RC_STRING_FIELDS = ['repo', 'ref', 'marketplace', 'displayName', 'marketplaceLabel'];

function readRc(dir) {
  if (!dir) return null;
  const file = path.join(dir, RC_NAME);
  let parsed;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      throw new UserError(`${file} is not valid JSON: ${err.message}`);
    }
    return null;
  }
  // The rc file is user-written configuration, so a wrong shape earns an error
  // that names the file - not an "Invalid repo: 123" three calls later with no
  // hint of where the value came from.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError(`${file} must be a JSON object.`);
  }
  for (const field of RC_STRING_FIELDS) {
    if (parsed[field] !== undefined && typeof parsed[field] !== 'string') {
      throw new UserError(`${file}: '${field}' must be a string.`);
    }
  }
  return parsed;
}

const firstSet = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

/**
 * Resolution order (first hit wins):
 *   CLI flag -> env (CP_*) -> .contextpluginsrc (cwd, then home)
 *            -> preset profile -> defaults
 */
function resolveBrand({
  flags = {},
  profile = {},
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
} = {}) {
  const rc = readRc(cwd) || readRc(home) || {};

  const displayName = firstSet(
    env.CP_DISPLAY_NAME,
    rc.displayName,
    profile.displayName,
    DEFAULT_PROFILE.displayName,
  );

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
    displayName,
    // What the user sees in place of the repository. The repository is an
    // implementation detail of where plugins are stored.
    label: firstSet(
      env.CP_MARKETPLACE_LABEL,
      rc.marketplaceLabel,
      profile.label,
      `${displayName} Marketplace`,
    ),
    bin: firstSet(profile.bin, DEFAULT_PROFILE.bin),
  };

  assertRepo(brand.repo);
  assertRef(brand.ref);
  return Object.freeze(brand);
}

module.exports = { DEFAULT_PROFILE, RC_NAME, resolveBrand, readRc };
