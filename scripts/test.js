'use strict';

// Runs the suite through tsx against src/*.ts, so no build sits in the loop.
// The file list is built here: Node 18/20 cannot glob in --test mode, and npm
// on Windows runs scripts under cmd.exe, which expands none at all.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Recursive: tests mirror the source tree, so they sit in subdirectories.
function collect(absDir, relDir) {
  const entries = fs
    .readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const found = [];
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) found.push(...collect(abs, rel));
    else if (entry.name.endsWith('.test.ts')) found.push(rel);
  }
  return found;
}

const files = collect(path.join(__dirname, '..', 'test'), 'test');

// A test that reaches the real CLI entry point must never send telemetry; the
// tests that exercise telemetry pin fetch and set CP_TELEMETRY themselves.
const env = { ...process.env, CP_TELEMETRY: process.env.CP_TELEMETRY || 'off' };

const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), '--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit', env },
);
process.exit(result.status === null ? 1 : result.status);
