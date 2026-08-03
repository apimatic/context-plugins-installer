'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const { UserError, ensureDir, which } = require('./util');
const pkg = require('../package.json');

/**
 * Anonymous usage events, silent unless a project token is configured.
 *
 * Nothing here may change what the CLI does: a missing token, an unwritable
 * state directory, or a refused request all degrade to silence rather than
 * failing an install.
 *
 * Only enumerated values leave the machine - harness names, a code from the
 * taxonomy below, versions, booleans. Never a filesystem path, a repository
 * name, a token, or an error message: those carry usernames and private
 * marketplace ids, and an error string is one refactor away from including a
 * home directory.
 */
const ENDPOINT = 'https://api.mixpanel.com/track';

// Set at release time. Until then telemetry stays off unless the environment
// supplies a token, so a `git clone` of this repo never reports anywhere.
const PROJECT_TOKEN = null;

// A CLI exits as soon as its work is done, so there is no idle time to send in:
// events are flushed before the command returns. Capped, because telemetry must
// never be the reason an install feels slow.
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Message -> stable code. The CLI's own errors are the only ones with fixed
 * wording, so anything unmatched is reported as a bucket rather than guessed at.
 * Order matters: the specific patterns come before the general ones.
 */
const ERROR_CODES = [
  [/already installed from a different marketplace/i, 'force_needed'],
  [/not installed on this machine|No supported editor found/i, 'no_editor_detected'],
  [/already has a marketplace named/i, 'marketplace_name_clash'],
  [/is not listed in/i, 'plugin_not_found'],
  [/is not a valid identifier/i, 'invalid_marketplace_name'],
  [/hosted in another repository/i, 'plugin_in_other_repo'],
  [/Could not determine the marketplace name|is not valid JSON|Could not read/i, 'marketplace_unreadable'],
  [/\b403\b/, 'github_rate_limit'],
  [/GitHub API request failed|Download failed/i, 'github_api_failed'],
  [/Could not reach/i, 'network_unreachable'],
  [/^git (clone|fetch|checkout|sparse-checkout)/i, 'git_failed'],
  [/is empty or missing in|has no files in/i, 'plugin_folder_empty'],
  [/^claude plugin install/i, 'claude_install_failed'],
  [/^Invalid (plugin id|repo|ref)/i, 'invalid_argument'],
];

/** A code for what went wrong, so failures can be counted without their text. */
function classifyError(err) {
  const message = (err && err.message) || '';
  const hit = ERROR_CODES.find(([pattern]) => pattern.test(message));
  if (hit) return hit[1];
  // A UserError is a known failure shape we have not named yet; anything else
  // is a bug, and worth telling apart from one.
  return err instanceof UserError ? 'other' : 'unexpected';
}

const NOOP = Object.freeze({
  enabled: false,
  track() {},
  async flush() {},
});

const optedOut = (env) =>
  Boolean(env.DO_NOT_TRACK || env.CP_TELEMETRY === '0' || env.CP_TELEMETRY === 'false');

/**
 * A stable id for this machine, so "installed once and never came back" can be
 * told apart from "installs something every week". Random, stored, and tied to
 * nothing - not a hash of hostname, user, or hardware.
 */
function anonymousId(pathOpts) {
  const file = paths.telemetryIdPath(pathOpts);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run on this machine */
  }
  const id = crypto.randomUUID();
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${id}\n`, 'utf8');
  } catch {
    // An unwritable state directory costs us retention numbers, not the install.
  }
  return id;
}

/**
 * Properties that describe the machine rather than the command, sent with every
 * event so the funnel can be split by them.
 */
function environmentProps(env) {
  return {
    cli_version: pkg.version,
    node_version: process.versions.node,
    os_platform: process.platform,
    os_release: os.release(),
    is_ci: Boolean(env.CI),
    git_available: Boolean(which('git', env)),
    // Presence only. The token itself is a credential.
    github_token_present: Boolean(env.CP_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN),
  };
}

function createTelemetry({ pathOpts, env = process.env, fetchImpl } = {}) {
  const token = env.CP_MIXPANEL_TOKEN || PROJECT_TOKEN;
  if (!token || optedOut(env)) return NOOP;

  const post = fetchImpl || fetch;
  const base = { distinct_id: anonymousId(pathOpts), ...environmentProps(env) };
  const pending = [];

  return {
    enabled: true,

    track(event, props = {}) {
      // $insert_id lets Mixpanel drop a duplicate if a retry ever lands twice.
      const properties = { token, $insert_id: crypto.randomUUID(), ...base, ...props };
      try {
        pending.push(
          post(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
            body: JSON.stringify([{ event, properties }]),
            signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
          }).catch(() => {}),
        );
      } catch {
        /* an unsendable event is not worth a word to the user */
      }
    },

    /** Wait for what is in flight, but never longer than the cap. */
    async flush() {
      if (!pending.length) return;
      const inflight = pending.splice(0);
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
          if (timer.unref) timer.unref();
        }),
      ]);
    },
  };
}

module.exports = { createTelemetry, classifyError, NOOP, ENDPOINT, FLUSH_TIMEOUT_MS };
