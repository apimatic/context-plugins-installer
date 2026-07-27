'use strict';

/**
 * Entry point for brand wrapper packages. A wrapper is not a fork - it is a
 * package.json plus a bin that hands this function a profile:
 *
 *   #!/usr/bin/env node
 *   require('context-plugins/run')({
 *     id: 'acme',                      // marketplace name in marketplace.json
 *     displayName: 'Acme AI Plugins',
 *     repo: 'acme/plugin-marketplace',
 *     bin: 'acme-plugins',             // the command name shown in help text
 *   })
 *
 * Every field is optional; anything omitted falls back to the neutral default,
 * and the user's own flags/env still take precedence over the profile.
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
