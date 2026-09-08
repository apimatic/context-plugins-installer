'use strict';

const js = require('@eslint/js');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');
const tseslint = require('typescript-eslint');

// The layering, now that every file in `src/` sits in one of these. Each
// directory may reach only the ones its block allows. `types/` is the bottom -
// importable by everything, importing nothing - and `composition/` is the top,
// importable by nothing, which is what makes it the only route a service takes
// to a command.
const LAYER = {
  actions: '**/actions/**',
  application: '**/application/**',
  commands: '**/commands/**',
  harnesses: '**/harnesses/**',
  infrastructure: '**/infrastructure/**',
  prompts: '**/prompts/**',
};

// The two files above every layer: the composition root and the entry point.
// Nothing in a layer may import either, so a service cannot be reached by
// naming the thing that built it, and a new module at the root is unreachable
// rather than unclassified.
const ROOT = ['**/composition/**', '**/main.js'];

const TERMINAL = ['**/prompts/terminal.js'];

const ROOT_MESSAGE =
  'src/composition/ and src/main.ts sit above every layer; nothing in one may import them. A service arrives as a port from types/, built by the composition root.';

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

/** One file's import boundary, for the two that are not a directory. */
const fileBoundary = (file, patterns) => ({
  files: [`src/${file}`],
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

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
        group: [...Object.values(LAYER), ...ROOT],
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
          ...ROOT,
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
    { group: ROOT, message: ROOT_MESSAGE },
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
    { group: ROOT, message: ROOT_MESSAGE },
  ]),
  boundary('harnesses', [
    {
      group: [LAYER.actions, LAYER.application, LAYER.commands, LAYER.prompts],
      message:
        'src/harnesses may import infrastructure/ and types/. It emits events; a prompts class turns them into prose.',
    },
    { group: ROOT, message: ROOT_MESSAGE },
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
    { group: ROOT, message: ROOT_MESSAGE },
  ]),
  boundary('commands', [
    {
      group: [LAYER.application, LAYER.harnesses, LAYER.infrastructure],
      message:
        'src/commands parses flags and calls an action; a service reaches it as a port from types/.',
    },
    {
      group: TERMINAL,
      message: 'A command speaks only through a prompts class, never to the terminal.',
    },
    { group: ROOT, message: ROOT_MESSAGE },
  ]),
  // The top of the stack. It may name any service, which is the whole point of
  // it, but it neither runs a command nor prints: `main.ts` joins it to the
  // router, and what a service says on the way past is the router's to render.
  boundary('composition', [
    {
      group: [LAYER.actions, LAYER.commands],
      message:
        'src/composition builds services; running a command is src/main.ts joining it to the router.',
    },
    {
      group: TERMINAL,
      message: 'The composition root wires the writer to a service; it does not write.',
    },
    {
      group: ['**/main.js'],
      message: 'src/main.ts imports the composition root, not the reverse.',
    },
  ]),
  // The entry point: argv in, exit code out. It builds the services and hands
  // them to the router, and may not reach past either.
  fileBoundary('main.ts', [
    {
      group: [
        LAYER.actions,
        LAYER.application,
        LAYER.harnesses,
        LAYER.infrastructure,
        LAYER.prompts,
      ],
      message:
        'src/main.ts may import commands/ and composition/ only: everything else is reached through one of those.',
    },
  ]),
  {
    // Repeated literals keep each test readable on its own.
    files: ['test/**'],
    rules: {
      'sonarjs/no-duplicate-string': 'off',
    },
  },
];
