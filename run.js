'use strict';

/**
 * Programmatic entry point: runs the CLI with a preset configuration.
 *
 * Accepts an optional profile of { id, displayName, repo, bin }. Any field left
 * out falls back to the default, and command-line flags and CP_* environment
 * variables still take precedence over it.
 */
module.exports = function runWithProfile(profile = {}, argv = process.argv.slice(2)) {
  return require('./src/cli')
    .run(argv, profile)
    .then((code) => {
      process.exitCode = code;
      return code;
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exitCode = 1;
      return 1;
    });
};
