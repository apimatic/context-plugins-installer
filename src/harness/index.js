'use strict';

const claude = require('./claude');
const cursor = require('./cursor');
const vscode = require('./vscode');

const HARNESSES = [claude, cursor, vscode];
const NAMES = HARNESSES.map((h) => h.name);

const byName = (name) => HARNESSES.find((h) => h.name === name);

/** Expand `all` / undefined into every harness; validate anything explicit. */
function resolveTargets(requested) {
  if (!requested || requested.length === 0 || requested.includes('all')) return [...NAMES];
  const unknown = requested.filter((t) => !NAMES.includes(t));
  if (unknown.length) {
    const { UserError } = require('../util');
    throw new UserError(`Unknown target(s): ${unknown.join(', ')}`, {
      hint: `Valid targets: ${NAMES.join(', ')}, all`,
    });
  }
  return NAMES.filter((n) => requested.includes(n)); // canonical order
}

module.exports = { HARNESSES, NAMES, byName, resolveTargets, claude, cursor, vscode };
