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

// Tests inject a fake spawner; everything else gets util.run.
const runner = (opts) => (opts && opts.run) || run;

const tail = (res) =>
  (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ').trim();

/**
 * Claude reports a missing plugin the same way whether the marketplace is stale
 * or the plugin genuinely does not exist, so this only decides whether a refresh
 * is worth one more attempt.
 */
const LOOKS_STALE = /not found in marketplace|out of date|marketplace update/i;

const REPO_IN = /(?:github\.com[/:]|^)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;

/**
 * The owner/repo a registered marketplace came from - null when Claude does not
 * say. The listing has carried the source under different keys across versions,
 * and a marketplace added from a local directory has no repo at all.
 */
function repoOf(entry) {
  const source = entry.source && typeof entry.source === 'object' ? entry.source : {};
  const fields = [
    entry.repo,
    entry.url,
    typeof entry.source === 'string' ? entry.source : null,
    source.repo,
    source.url,
  ];
  for (const field of fields) {
    const hit = field && String(field).trim().match(REPO_IN);
    if (hit) return hit[1];
  }
  return null;
}

const isSameRepo = (entry, repo) => {
  const from = repoOf(entry);
  if (from) return from.toLowerCase() === repo.toLowerCase();
  // Unrecognised shape: fall back to looking for the repo anywhere in the entry.
  return JSON.stringify(entry).toLowerCase().includes(repo.toLowerCase());
};

/** Registered marketplaces, or null on a CLI too old to list them as JSON. */
async function listMarketplaces(exec, claude) {
  const res = await exec(claude, ['plugin', 'marketplace', 'list', '--json']);
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(stripBom(res.stdout));
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.marketplaces) ? parsed.marketplaces : null;
  } catch {
    return null; // older CLI without --json
  }
}

/**
 * The name Claude Code knows this marketplace by.
 *
 * Claude keys a marketplace by the name it carried when it was added, which can
 * drift from the current `name` in marketplace.json. Installing with the name
 * from the file then fails with a bare "plugin not found in marketplace", so ask
 * Claude what it calls the entry for this repository.
 */
async function registeredName(exec, claude, repo) {
  const entries = await listMarketplaces(exec, claude);
  const hit = entries && entries.find((e) => isSameRepo(e, repo));
  return hit && hit.name ? hit.name : null;
}

async function refresh(exec, claude, known) {
  const res = await exec(claude, ['plugin', 'marketplace', 'update', known]);
  if (res.code === 0) {
    log.ok(`Updated marketplace '${known}'`);
    return true;
  }
  log.warn(
    `Could not update marketplace '${known}' (exit ${res.code}) - continuing with the local copy. ${tail(res)}`.trim(),
  );
  return false;
}

/**
 * Leave Claude with this marketplace registered *and* current, and report the
 * name it is registered under.
 *
 * Users often add the marketplace by hand before they ever run this installer.
 * `marketplace add` then fails, and Claude's local copy - cloned before the
 * plugin existed - makes the install fail with "plugin not found in
 * marketplace". So an entry that is already there gets refreshed rather than
 * assumed good.
 */
async function ensureMarketplace(exec, claude, { marketplace, repo }) {
  const entries = await listMarketplaces(exec, claude);
  const existing = entries && entries.find((e) => isSameRepo(e, repo));

  if (existing) {
    const known = existing.name || marketplace;
    if (known !== marketplace) {
      log.debug(`Claude knows this marketplace as '${known}', not '${marketplace}'.`);
    }
    log.info(`Marketplace '${known}' is already registered - updating it.`);
    await refresh(exec, claude, known);
    return { known, updated: true };
  }

  // Nothing registered points at our repo. A same-named entry would swallow the
  // install and report a missing plugin, so deal with it here: refuse only when
  // Claude tells us it demonstrably came from somewhere else, and otherwise
  // treat it as ours and refresh it rather than fail on a guess.
  const clash = entries && entries.find((e) => e.name === marketplace);
  if (clash) {
    const from = repoOf(clash);
    if (from) {
      throw new UserError(
        `Claude Code already has a marketplace named '${marketplace}', from ${from} rather than ${repo}.`,
        {
          hint: `Remove it with \`claude plugin marketplace remove ${marketplace}\`, then run this again.`,
        },
      );
    }
    log.info(`Marketplace '${marketplace}' is already registered - updating it.`);
    await refresh(exec, claude, marketplace);
    return { known: marketplace, updated: true };
  }

  const added = await exec(claude, ['plugin', 'marketplace', 'add', repo]);
  if (added.code === 0) {
    log.ok(`Added marketplace '${marketplace}'`);
    return { known: (await registeredName(exec, claude, repo)) || marketplace, updated: false };
  }

  // `add` failing with no entry in sight usually means one exists that we could
  // not see - an older CLI has no --json listing. Refresh by the configured name
  // so a stale copy still gets a chance; the install reports the truth either way.
  log.debug(`marketplace add returned ${added.code} (likely already added). ${tail(added)}`);
  const res = await exec(claude, ['plugin', 'marketplace', 'update', marketplace]);
  if (res.code === 0) log.ok(`Updated marketplace '${marketplace}'`);
  return { known: marketplace, updated: true };
}

/**
 * Registering a marketplace is per-repository work, not per-plugin: it costs two
 * `claude` invocations and a network fetch, and the answer is the same for every
 * plugin that comes from it. During `update` the session remembers it so the
 * second plugin onwards skips straight to installing.
 *
 * The promise is cached rather than its result, so a failure is shared too - if
 * the marketplace cannot be registered, every plugin from it fails the same way
 * instead of retrying a deterministic error N times.
 */
function ensureMarketplaceOnce(exec, claude, { marketplace, repo }, session) {
  if (!session || !session.marketplaces) {
    return ensureMarketplace(exec, claude, { marketplace, repo });
  }
  const key = `${repo}::${marketplace}`;
  if (!session.marketplaces.has(key)) {
    session.marketplaces.set(key, ensureMarketplace(exec, claude, { marketplace, repo }));
  }
  return session.marketplaces.get(key);
}

async function install({ plugin, marketplace, repo, session }, opts) {
  const claude = cli(opts);
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }
  const exec = runner(opts);

  const { known, updated } = await ensureMarketplaceOnce(
    exec,
    claude,
    { marketplace, repo },
    session,
  );
  const target = `${plugin}@${known}`;
  const args = ['plugin', 'install', target, '--scope', 'user'];

  let res = await exec(claude, args);
  // The marketplace resolved but its local clone predates the plugin: worth one
  // refresh and a retry, unless an update was already attempted above.
  if (res.code !== 0 && !updated && LOOKS_STALE.test(`${res.stderr || ''}${res.stdout || ''}`)) {
    log.debug(`'${target}' is not in the local copy - refreshing '${known}' and retrying.`);
    if (await refresh(exec, claude, known)) res = await exec(claude, args);
  }
  if (res.code !== 0) {
    throw new UserError(
      `claude plugin install ${target} failed (exit ${res.code}). ${tail(res)}`.trim(),
      {
        hint: LOOKS_STALE.test(`${res.stderr || ''}${res.stdout || ''}`)
          ? `'${plugin}' is not in marketplace '${known}'. Run \`npx context-plugins list\` to see what it offers.`
          : undefined,
      },
    );
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
  const exec = runner(opts);
  const known = await registeredName(exec, claude, repo);
  const target = `${plugin}@${known || marketplace}`;
  const res = await exec(claude, ['plugin', 'uninstall', target, '--scope', 'user']);
  if (res.code !== 0) {
    log.warn(`claude plugin uninstall ${target} returned ${res.code}. ${tail(res)}`.trim());
    return false;
  }
  log.ok(`Uninstalled ${target}`);
  log.info('Restart `claude` or /reload-plugins to unload the plugin.');
  return true;
}

const location = () => 'claude on PATH';

module.exports = {
  name,
  title,
  detect,
  location,
  install,
  uninstall,
  ensureMarketplaceOnce,
  needsSource: false,
};
