'use strict';

const js = require('@eslint/js');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'lib/', '.claude/worktrees/'] },
  js.configs.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // TS rules only on .ts, so the plain-JS entry points keep `require`.
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
    // Only the ANSI handling legitimately matches control characters.
    files: ['src/log.ts', 'test/**'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // Repeated literals keep each test readable on its own.
    files: ['test/**'],
    rules: {
      'sonarjs/no-duplicate-string': 'off',
    },
  },
];
