'use strict';

// Runs the suite through tsx against src/*.ts, so no build sits in the loop.
// The file list is built here: Node 18/20 cannot glob in --test mode, and npm
// on Windows runs scripts under cmd.exe, which expands none at all.
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
