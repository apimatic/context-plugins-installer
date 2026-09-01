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
      // A terminal CLI legitimately matches ESC: log.js strips ANSI codes and
      // the prompt tests assert on cursor sequences.
      'no-control-regex': 'off',
      // toAscii's regex deliberately contains a non-breaking space - mapping it
      // to a plain space is the function's whole job.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
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
