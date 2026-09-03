import { log } from '../log.js';
import type {
  HarnessContext,
  HarnessName,
  HarnessOpts,
  MarketplaceListing,
  RunCommand,
  RunResult,
  Session,
  UninstallOutcome,
} from '../types.js';
import { which, run, UserError, stripBom, isPlainObject, nonEmptyString } from '../util.js';

export const name: HarnessName = 'claude';
export const title = 'Claude Code';
export const needsSource = false;

const cli = (opts?: HarnessOpts): string | null => which('claude', opts?.env || process.env);
export const detect = (opts?: HarnessOpts): boolean => Boolean(cli(opts));

const runner = (opts?: HarnessOpts): RunCommand => opts?.run || run;

const tail = (res: RunResult): string =>
  (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ').trim();

// Claude reports a missing plugin the same way whether the marketplace copy is
// stale or the plugin does not exist; this only decides whether a refresh is
// worth one retry.
const LOOKS_STALE = /not found in marketplace|out of date|marketplace update/i;

// The fallback when the plugin listing cannot answer. Every alternative has to
// be unambiguously about a plugin: "is not installed" also matches a
// marketplace's own failure, and `plugin marketplace` is a subcommand.
const LOOKS_ABSENT = /not found in installed plugins|no such plugin/i;

// Named by every install and uninstall, so the only scope that can say whether
// a record has drifted.
const SCOPE = 'user';

// Scopes that are definitely not this tool's. Anything else, a word this build
// has never seen included, counts as possibly ours: an unrecognised value must
// never be the thing that reads as absence.
const OTHER_SCOPES = new Set(['project', 'local']);

const REPO_IN = /(?:github\.com[/:]|^)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;

// The listing has carried the source under different keys across CLI versions,
// and a marketplace added from a local directory has no repo at all.
function repoOf(entry: MarketplaceListing): string | null {
  const source = isPlainObject(entry.source) ? entry.source : {};
  const fields: unknown[] = [
    entry.repo,
    entry.url,
    typeof entry.source === 'string' ? entry.source : null,
    source.repo,
    source.url,
  ];
  for (const field of fields) {
    const hit = field ? String(field).trim().match(REPO_IN) : null;
    if (hit?.[1]) return hit[1];
  }
  return null;
}

const isSameRepo = (entry: MarketplaceListing, repo: string): boolean => {
  const from = repoOf(entry);
  if (from) return from.toLowerCase() === repo.toLowerCase();
  return JSON.stringify(entry).toLowerCase().includes(repo.toLowerCase());
};

/**
 * The one `claude ... --json` boundary: a bare array, or `{ [key]: [...] }`.
 * null means the CLI could not answer - too old for `--json`, or a shape this
 * build cannot read - which every caller must treat as "unknown", never "none".
 */
async function listJson(
  exec: RunCommand,
  claude: string,
  args: string[],
  key: string,
): Promise<unknown[] | null> {
  const res = await exec(claude, [...args, '--json']);
  if (res.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(stripBom(res.stdout));
    if (Array.isArray(parsed)) return parsed;
    return isPlainObject(parsed) && Array.isArray(parsed[key]) ? parsed[key] : null;
  } catch {
    return null;
  }
}

/**
 * null on a CLI too old to list marketplaces as JSON. Junk rows are dropped
 * rather than fatal: one unreadable marketplace must not hide the rest, and the
 * worst case is re-adding one that was already there.
 */
async function listMarketplaces(
  exec: RunCommand,
  claude: string,
): Promise<MarketplaceListing[] | null> {
  const entries = await listJson(exec, claude, ['plugin', 'marketplace', 'list'], 'marketplaces');
  return entries ? entries.filter(isPlainObject) : null;
}

interface InstalledPlugin {
  plugin: string;
  /** null when the listing does not say, which counts as "could be ours". */
  scope: string | null;
}

/** null on a CLI whose plugin listing cannot be read. */
async function installedPlugins(
  exec: RunCommand,
  claude: string,
): Promise<InstalledPlugin[] | null> {
  const entries = await listJson(exec, claude, ['plugin', 'list'], 'plugins');
  if (!entries) return null;
  const rows = entries.flatMap((e) => {
    if (!isPlainObject(e) || !nonEmptyString(e.id)) return [];
    // `plugin@marketplace`, where the marketplace half is Claude's own name for it.
    const at = e.id.lastIndexOf('@');
    return [
      {
        plugin: at > 0 ? e.id.slice(0, at) : e.id,
        scope: nonEmptyString(e.scope) ? e.scope : null,
      },
    ];
  });
  // Read whole or not at all: absence is the only conclusion drawn from this, so
  // one row that will not parse makes the answer unknown, never "none".
  if (rows.length !== entries.length) return null;
  return rows;
}

// Claude keys a marketplace by the name it had when added, which drifts from
// the current `name` in marketplace.json; installing under the file's name
// then fails with a bare "plugin not found in marketplace".
async function registeredName(
  exec: RunCommand,
  claude: string,
  repo: string,
): Promise<string | null> {
  const entries = await listMarketplaces(exec, claude);
  const hit = entries?.find((e) => isSameRepo(e, repo));
  return hit && nonEmptyString(hit.name) ? hit.name : null;
}

async function refresh(exec: RunCommand, claude: string, known: string): Promise<boolean> {
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

interface MarketplaceIds {
  marketplace: string;
  repo: string;
}

interface Registration {
  known: string;
  updated: boolean;
}

// A marketplace the user added by hand may predate the plugin, so an existing
// entry is refreshed rather than assumed current.
async function ensureMarketplace(
  exec: RunCommand,
  claude: string,
  { marketplace, repo }: MarketplaceIds,
): Promise<Registration> {
  const entries = await listMarketplaces(exec, claude);
  const existing = entries?.find((e) => isSameRepo(e, repo));

  if (existing) {
    const known = nonEmptyString(existing.name) ? existing.name : marketplace;
    if (known !== marketplace) {
      log.debug(`Claude knows this marketplace as '${known}', not '${marketplace}'.`);
    }
    log.info(`Marketplace '${known}' is already registered - updating it.`);
    await refresh(exec, claude, known);
    return { known, updated: true };
  }

  // A same-named entry from another repo would swallow the install; refuse only
  // when Claude can say where it came from, otherwise treat it as ours.
  const clash = entries?.find((e) => e.name === marketplace);
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

  // `add` failing with nothing listed usually means an older CLI that cannot
  // list as JSON; refresh by the configured name and let the install report.
  log.debug(`marketplace add returned ${added.code} (likely already added). ${tail(added)}`);
  const res = await exec(claude, ['plugin', 'marketplace', 'update', marketplace]);
  if (res.code === 0) log.ok(`Updated marketplace '${marketplace}'`);
  return { known: marketplace, updated: true };
}

// Memoized per session, promise rather than result, so a failed registration
// is shared instead of retried for every plugin from that marketplace.
export function ensureMarketplaceOnce(
  exec: RunCommand,
  claude: string,
  ids: MarketplaceIds,
  session?: Session | null,
): Promise<Registration> {
  if (!session?.marketplaces) {
    return ensureMarketplace(exec, claude, ids);
  }
  const key = `${ids.repo}::${ids.marketplace}`;
  let pending = session.marketplaces.get(key);
  if (!pending) {
    pending = ensureMarketplace(exec, claude, ids);
    session.marketplaces.set(key, pending);
  }
  return pending;
}

export async function install(
  { plugin, marketplace, repo, session }: HarnessContext,
  opts?: HarnessOpts,
) {
  const claude = cli(opts);
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }
  if (!marketplace) {
    log.warn('No marketplace name to install from - skipping Claude Code.');
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
  const args = ['plugin', 'install', target, '--scope', SCOPE];

  let res = await exec(claude, args);
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

// Claude fails the same way whether the plugin is missing or something went
// wrong, so its listing decides - on the plugin id alone, since the marketplace
// half is its own name for it, and only at the scope this tool owns.
async function isAbsent(
  exec: RunCommand,
  claude: string,
  plugin: string,
  res: RunResult,
): Promise<boolean> {
  const rows = await installedPlugins(exec, claude);
  if (!rows) {
    // The failure has to be about this plugin, not merely worded like it.
    const text = `${res.stderr || ''}${res.stdout || ''}`;
    return text.includes(plugin) && LOOKS_ABSENT.test(text);
  }
  const ours = (scope: string | null): boolean => !OTHER_SCOPES.has((scope || SCOPE).toLowerCase());
  return !rows.some((r) => r.plugin === plugin && ours(r.scope));
}

export async function uninstall(
  { plugin, marketplace, repo }: HarnessContext,
  opts?: HarnessOpts,
): Promise<UninstallOutcome> {
  const claude = cli(opts);
  // A skip, not a failure: Claude Code is not here to fail, and the record
  // stands until a run that can reach it says otherwise.
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return 'skipped';
  }
  const exec = runner(opts);
  const known = (await registeredName(exec, claude, repo)) || marketplace;
  if (!known) {
    log.warn('No marketplace name to uninstall from - skipping Claude Code.');
    return 'skipped';
  }
  const target = `${plugin}@${known}`;
  const res = await exec(claude, ['plugin', 'uninstall', target, '--scope', SCOPE]);
  if (res.code !== 0) {
    // True whether it was never installed or a command removed it and then failed.
    if (await isAbsent(exec, claude, plugin, res)) {
      log.info(`Claude Code has no '${plugin}' at ${SCOPE} scope - nothing left to remove.`);
      return 'absent';
    }
    log.warn(`claude plugin uninstall ${target} returned ${res.code}. ${tail(res)}`.trim());
    return 'failed';
  }
  log.ok(`Uninstalled ${target}`);
  log.info('Restart `claude` or /reload-plugins to unload the plugin.');
  return 'removed';
}

export const location = (): string => 'claude on PATH';
