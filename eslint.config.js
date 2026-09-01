'use strict';

const js = require('@eslint/js');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // The codebase marks deliberately unused parameters with a _ prefix
      // (e.g. `(_m, c) =>` in replace callbacks); keep that convention legal.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // toAscii's regex deliberately contains a non-breaking space - mapping it
      // to a plain space is the function's whole job.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
  {
    // Only the ANSI machinery legitimately matches control characters: log.js
    // strips escape codes, and tests assert on cursor sequences. Everywhere
    // else - settings-merge.js does raw-text surgery on the user's
    // settings.json - a control character in a regex is a mistake worth
    // catching.
    files: ['src/log.js', 'test/**'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // Test cases repeat literals ('acme/plugin-marketplace', 'plugins/my-sdk')
    // so each test reads standalone; hoisting them into constants would hide
    // the very values the assertions are about.
    files: ['test/**'],
    rules: {
      'sonarjs/no-duplicate-string': 'off',
    },
  },
];
