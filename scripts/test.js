'use strict';

// Runs the suite through tsx, so tests import src/*.ts directly and no build
// step sits in the loop. The file list is built here because Node 18 and 20
// cannot expand globs in --test mode, and npm on Windows runs scripts under
// cmd.exe, which expands none at all. Extra arguments pass through to node
// (e.g. `npm test -- --test-name-pattern manifest`).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => path.join('test', f));

const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), '--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit' },
);
process.exit(result.status === null ? 1 : result.status);
