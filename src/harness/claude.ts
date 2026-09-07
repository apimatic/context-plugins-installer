import { claudeCli, findClaude, type ClaudeCli } from '../infrastructure/claude-cli.js';
import { log } from '../log.js';
import {
  TITLES,
  type HarnessContext,
  type HarnessName,
  type HarnessOpts,
  type MarketplaceListing,
  type UninstallOutcome,
} from '../types/harness.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type { RunResult } from '../types/ports.js';
import type { Session } from '../types/session.js';
import { UserError, isPlainObject, nonEmptyString } from '../util.js';

export const name: HarnessName = 'claude';
export const title = TITLES.claude;
export const needsSource = false;

const binary = (opts?: HarnessOpts): string | null => findClaude(opts?.env || process.env);
export const detect = (opts?: HarnessOpts): boolean => Boolean(binary(opts));

const cliFor = (claude: string, opts?: HarnessOpts): ClaudeCli => claudeCli(claude, opts?.run);

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

// The listing has carried the source under different keys across CLI versions,
// and a marketplace added from a local directory has no repo at all.
function repoOf(entry: MarketplaceListing): RepoSlug | null {
  const source = isPlainObject(entry.source) ? entry.source : {};
  const fields: unknown[] = [
    entry.repo,
    entry.url,
    typeof entry.source === 'string' ? entry.source : null,
    source.repo,
    source.url,
  ];
  for (const field of fields) {
    const slug = RepoSlug.fromText(field);
    if (slug) return slug;
  }
  return null;
}

const isSameRepo = (entry: MarketplaceListing, repo: RepoSlug): boolean => {
  const from = repoOf(entry);
  if (from) return from.matches(repo);
  return JSON.stringify(entry).toLowerCase().includes(repo.toSearchKey());
};

// Claude keys a marketplace by the name it had when added, which drifts from
// the current `name` in marketplace.json; installing under the file's name
// then fails with a bare "plugin not found in marketplace".
async function registeredName(cli: ClaudeCli, repo: string): Promise<string | null> {
  const entries = await cli.listMarketplaces();
  const hit = entries?.find((e) => isSameRepo(e, new RepoSlug(repo)));
  return hit && nonEmptyString(hit.name) ? hit.name : null;
}

async function refresh(cli: ClaudeCli, known: string): Promise<boolean> {
  const res = await cli.marketplaceUpdate(known);
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
  cli: ClaudeCli,
  { marketplace, repo }: MarketplaceIds,
): Promise<Registration> {
  const entries = await cli.listMarketplaces();
  const existing = entries?.find((e) => isSameRepo(e, new RepoSlug(repo)));

  if (existing) {
    const known = nonEmptyString(existing.name) ? existing.name : marketplace;
    if (known !== marketplace) {
      log.debug(`Claude knows this marketplace as '${known}', not '${marketplace}'.`);
    }
    log.info(`Marketplace '${known}' is already registered - updating it.`);
    await refresh(cli, known);
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
    await refresh(cli, marketplace);
    return { known: marketplace, updated: true };
  }

  const added = await cli.marketplaceAdd(repo);
  if (added.code === 0) {
    log.ok(`Added marketplace '${marketplace}'`);
    return { known: (await registeredName(cli, repo)) || marketplace, updated: false };
  }

  // `add` failing with nothing listed usually means an older CLI that cannot
  // list as JSON; refresh by the configured name and let the install report.
  log.debug(`marketplace add returned ${added.code} (likely already added). ${tail(added)}`);
  const res = await cli.marketplaceUpdate(marketplace);
  if (res.code === 0) log.ok(`Updated marketplace '${marketplace}'`);
  return { known: marketplace, updated: true };
}

// Memoized per session, promise rather than result, so a failed registration
// is shared instead of retried for every plugin from that marketplace.
export function ensureMarketplaceOnce(
  cli: ClaudeCli,
  ids: MarketplaceIds,
  session?: Session | null,
): Promise<Registration> {
  if (!session?.marketplaces) {
    return ensureMarketplace(cli, ids);
  }
  const key = `${ids.repo}::${ids.marketplace}`;
  let pending = session.marketplaces.get(key);
  if (!pending) {
    pending = ensureMarketplace(cli, ids);
    session.marketplaces.set(key, pending);
  }
  return pending;
}

export async function install(
  { plugin, marketplace, repo, session }: HarnessContext,
  opts?: HarnessOpts,
) {
  const claude = binary(opts);
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return false;
  }
  if (!marketplace) {
    log.warn('No marketplace name to install from - skipping Claude Code.');
    return false;
  }
  const cli = cliFor(claude, opts);

  const { known, updated } = await ensureMarketplaceOnce(cli, { marketplace, repo }, session);
  const target = `${plugin}@${known}`;

  let res = await cli.pluginInstall(target, SCOPE);
  if (res.code !== 0 && !updated && LOOKS_STALE.test(`${res.stderr || ''}${res.stdout || ''}`)) {
    log.debug(`'${target}' is not in the local copy - refreshing '${known}' and retrying.`);
    if (await refresh(cli, known)) res = await cli.pluginInstall(target, SCOPE);
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
async function isAbsent(cli: ClaudeCli, plugin: string, res: RunResult): Promise<boolean> {
  const rows = await cli.listPlugins();
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
  const claude = binary(opts);
  // A skip, not a failure: Claude Code is not here to fail, and the record
  // stands until a run that can reach it says otherwise.
  if (!claude) {
    log.warn("'claude' CLI not on PATH - skipping Claude Code.");
    return 'skipped';
  }
  const cli = cliFor(claude, opts);
  const known = (await registeredName(cli, repo)) || marketplace;
  if (!known) {
    log.warn('No marketplace name to uninstall from - skipping Claude Code.');
    return 'skipped';
  }
  const target = `${plugin}@${known}`;
  const res = await cli.pluginUninstall(target, SCOPE);
  if (res.code !== 0) {
    // True whether it was never installed or a command removed it and then failed.
    if (await isAbsent(cli, plugin, res)) {
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
