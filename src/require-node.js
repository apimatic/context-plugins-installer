'use strict';

// Deliberately plain, old-syntax JavaScript with no imports: this has to parse
// and run on whatever ancient Node the user happens to have.

var MINIMUM = 18;

module.exports = function requireNode(exit) {
  var version = process.versions.node;
  var major = parseInt(version.split('.')[0], 10);
  if (major >= MINIMUM) return true;

  process.stderr.write(
    'context-plugins requires Node.js ' +
      MINIMUM +
      ' or newer, but this is Node.js ' +
      version +
      '.\n' +
      'Install a newer Node.js from https://nodejs.org and run this again.\n',
  );
  (exit || process.exit)(1);
  return false;
};
