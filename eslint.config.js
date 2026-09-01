'use strict';

const js = require('@eslint/js');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'lib/'] },
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
  // TypeScript sources: the TS parser and rules apply only here, so the plain
  // JavaScript entry points (bin/, run.js, scripts/, this file) stay under the
  // CommonJS rules above and are never told off for `require`.
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: { sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Only the ANSI machinery legitimately matches control characters: log.ts
    // strips escape codes, and tests assert on cursor sequences. Everywhere
    // else - settings-merge.ts does raw-text surgery on the user's
    // settings.json - a control character in a regex is a mistake worth
    // catching.
    files: ['src/log.ts', 'test/**'],
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
