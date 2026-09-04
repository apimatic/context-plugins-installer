'use strict';

const js = require('@eslint/js');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');
const tseslint = require('typescript-eslint');

// The layering the refactor is moving to. Each directory may reach only the ones
// its block allows, and the rules are scoped to those directories, so they bite
// as code moves in rather than all at once at the end. `types/` sits at the
// bottom: importable by everything, importing nothing.
const LAYER = {
  actions: '**/actions/**',
  application: '**/application/**',
  commands: '**/commands/**',
  harnesses: '**/harnesses/**',
  infrastructure: '**/infrastructure/**',
  prompts: '**/prompts/**',
};

// `src/log.ts` is the migration shim in front of prompts/terminal.ts, so it is
// no more importable from a layer than the writer it re-exports.
const LOG_SHIM = '**/log.js';
const TERMINAL = [LOG_SHIM, '**/prompts/terminal.js'];

// Everything a pure layer must not reach, in both spellings: `require('fs')` and
// `require('node:fs')` are the same module, so a list naming one and not the
// other is a hole. `node:crypto` is here for nondeterminism rather than I/O - a
// decision that mints a UUID is not a decision that can be tested twice.
//
// A denylist, reluctantly. An allowlist would be the better shape, since a
// builtin Node adds later would then be barred by default, but this rule's
// `group` globs support neither negation nor a "bare specifier" pattern that
// leaves relative imports alone: `'*/*'` matches `'./failure.js'` too. Measured,
// not assumed. So when Node grows a way to touch the world, add it here.
const NODE_IO = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'os',
  'node:os',
  'child_process',
  'node:child_process',
  'crypto',
  'node:crypto',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dns',
  'node:dns',
  'dgram',
  'node:dgram',
  'cluster',
  'node:cluster',
  'worker_threads',
  'node:worker_threads',
  'zlib',
  'node:zlib',
  'readline',
  'node:readline',
  'readline/promises',
  'node:readline/promises',
  'process',
  'node:process',
];

/** One directory's import boundary. `noIo` also bars the node builtins above. */
const boundary = (dir, patterns, { noIo = false } = {}) => {
  const options = { patterns };
  if (noIo) {
    options.paths = NODE_IO.map((name) => ({
      name,
      message: `src/${dir} does no I/O - take a port in the constructor and let infrastructure/ do it.`,
    }));
  }
  return {
    files: [`src/${dir}/**/*.ts`],
    rules: { 'no-restricted-imports': ['error', options] },
  };
};

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
    files: ['src/prompts/terminal.ts', 'test/**'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // Every user-visible line goes through a prompts class.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // The one writer, and the reason the rule above can be absolute.
    files: ['src/prompts/terminal.ts'],
    rules: { 'no-console': 'off' },
  },
  boundary(
    'types',
    [
      {
        group: [...Object.values(LAYER), LOG_SHIM],
        message: 'src/types is the bottom of the stack: it may import types/ and nothing else.',
      },
    ],
    { noIo: true },
  ),
  boundary(
    'application',
    [
      {
        group: [
          LAYER.actions,
          LAYER.commands,
          LAYER.harnesses,
          LAYER.infrastructure,
          LAYER.prompts,
          LOG_SHIM,
        ],
        message: 'src/application is pure - data in, data out. It may import types/ only.',
      },
    ],
    { noIo: true },
  ),
  boundary('infrastructure', [
    {
      group: [LAYER.actions, LAYER.application, LAYER.commands, LAYER.harnesses, LAYER.prompts],
      message: 'src/infrastructure may import types/ and node builtins, nothing above it.',
    },
    {
      group: [LOG_SHIM],
      message: 'src/infrastructure never prints: return a Result and let the caller say so.',
    },
  ]),
  boundary('prompts', [
    {
      group: [
        LAYER.actions,
        LAYER.application,
        LAYER.commands,
        LAYER.harnesses,
        LAYER.infrastructure,
      ],
      message: 'src/prompts renders and asks; it may import types/ and prompts/ only.',
    },
    { group: [LOG_SHIM], message: 'Import ./terminal.js directly, not the migration shim.' },
  ]),
  boundary('harnesses', [
    {
      group: [LAYER.actions, LAYER.application, LAYER.commands, LAYER.prompts],
      message:
        'src/harnesses may import infrastructure/ and types/. It emits events; a prompts class turns them into prose.',
    },
    { group: [LOG_SHIM], message: 'src/harnesses does not print: emit a HarnessEvent instead.' },
  ]),
  boundary('actions', [
    {
      group: [LAYER.commands],
      message: 'src/actions is called by commands/, never the other way round.',
    },
    {
      group: TERMINAL,
      message: 'An action speaks only through its own prompts class, never to the terminal.',
    },
  ]),
  boundary('commands', [
    {
      group: [LAYER.application, LAYER.harnesses, LAYER.infrastructure],
      message:
        'src/commands parses flags and calls an action; services reach it through composition.ts.',
    },
    { group: [LOG_SHIM], message: 'Import prompts/format.js, not the migration shim.' },
  ]),
  {
    // Repeated literals keep each test readable on its own.
    files: ['test/**'],
    rules: {
      'sonarjs/no-duplicate-string': 'off',
    },
  },
];
