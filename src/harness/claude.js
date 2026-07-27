'use strict';

const log = require('../log');
const { which, run, UserError } = require('../util');

// Claude Code installs from the marketplace itself - no local copy needed.
const name = 'claude';
const title = 'Claude Code';

const cli = () => which('claude');
const detect = () => Boolean(cli());

const tail = (res) =>
  (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ').trim();

async function install({ plugin, marketplace, repo }) {
  const claude = cli();
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }

  const added = await run(claude, ['plugin', 'marketplace', 'add', repo]);
  if (added.code !== 0) {
    log.info(`marketplace add returned ${added.code} (likely already added) - continuing.`);
  }

  const target = `${plugin}@${marketplace}`;
  const res = await run(claude, ['plugin', 'install', target, '--scope', 'user']);
  if (res.code !== 0) {
    throw new UserError(`claude plugin install ${target} failed (exit ${res.code}). ${tail(res)}`.trim());
  }
  log.ok(`Installed ${target} (user scope)`);
  log.info('Start `claude`; skills load automatically. /plugin lists what is installed.');
  return true;
}

async function uninstall({ plugin, marketplace }) {
  const claude = cli();
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }
  const target = `${plugin}@${marketplace}`;
  const res = await run(claude, ['plugin', 'uninstall', target, '--scope', 'user']);
  if (res.code !== 0) {
    log.warn(`claude plugin uninstall ${target} returned ${res.code}. ${tail(res)}`.trim());
    return false;
  }
  log.ok(`Uninstalled ${target}`);
  return true;
}

module.exports = { name, title, detect, install, uninstall, needsSource: false };
