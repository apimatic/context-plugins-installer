'use strict';

/** Runs the CLI with a preset profile; flags and CP_* env still take precedence. */
module.exports = function runWithProfile(profile = {}, argv = process.argv.slice(2)) {
  require('./bin/require-node')();
  return require('./lib/cli')
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
