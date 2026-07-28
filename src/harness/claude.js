'use strict';

const log = require('../log');
const { which, run, UserError, stripBom } = require('../util');

// Claude Code installs from the marketplace itself - no local copy needed.
const name = 'claude';
const title = 'Claude Code';

// Honours opts.env like the other harnesses, so a sandboxed test machine can
// present a PATH without `claude` on it.
const cli = (opts) => which('claude', (opts && opts.env) || process.env);
const detect = (opts) => Boolean(cli(opts));

const tail = (res) =>
  (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ').trim();

/**
 * The name Claude Code knows this marketplace by.
 *
 * Claude keys a marketplace by the name it carried when it was added, which can
 * drift from the current `name` in marketplace.json. Installing with the name
 * from the file then fails with a bare "plugin not found in marketplace", so ask
 * Claude what it calls the entry for this repository.
 */
async function registeredName(claude, repo) {
  const res = await run(claude, ['plugin', 'marketplace', 'list', '--json']);
  if (res.code !== 0) return null;
  try {
    const entries = JSON.parse(stripBom(res.stdout));
    const hit = entries.find((m) => m.repo === repo || String(m.url || '').includes(repo));
    return hit && hit.name ? hit.name : null;
  } catch {
    return null; // older CLI without --json
  }
}

async function install({ plugin, marketplace, repo }, opts) {
  const claude = cli(opts);
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }

  const added = await run(claude, ['plugin', 'marketplace', 'add', repo]);
  if (added.code !== 0) {
    log.debug(`marketplace add returned ${added.code} (likely already added) - continuing.`);
  }

  const known = await registeredName(claude, repo);
  if (known && known !== marketplace) {
    log.debug(`Claude knows this marketplace as '${known}', not '${marketplace}'.`);
  }
  const target = `${plugin}@${known || marketplace}`;
  const res = await run(claude, ['plugin', 'install', target, '--scope', 'user']);
  if (res.code !== 0) {
    throw new UserError(`claude plugin install ${target} failed (exit ${res.code}). ${tail(res)}`.trim());
  }
  log.ok(`Installed ${target} (user scope)`);
  log.info('Start with `claude` or /reload-plugins to load newly added plugin.');
  return true;
}

async function uninstall({ plugin, marketplace, repo }, opts) {
  const claude = cli(opts);
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }
  const known = await registeredName(claude, repo);
  const target = `${plugin}@${known || marketplace}`;
  const res = await run(claude, ['plugin', 'uninstall', target, '--scope', 'user']);
  if (res.code !== 0) {
    log.warn(`claude plugin uninstall ${target} returned ${res.code}. ${tail(res)}`.trim());
    return false;
  }
  log.ok(`Uninstalled ${target}`);
  log.info('Restart `claude` or /reload-plugins to unload the plugin.');
  return true;
}

const location = () => 'claude on PATH';

module.exports = { name, title, detect, location, install, uninstall, needsSource: false };
