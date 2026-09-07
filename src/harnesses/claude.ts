import { claudeCli, findClaude, type ClaudeCli } from '../infrastructure/claude-cli.js';
import {
  TITLES,
  type ClaudeEvent,
  type Harness,
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

/** This harness's half of the listener: it only ever emits Claude events. */
type Say = (event: ClaudeEvent) => void;

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

export interface MarketplaceIds {
  marketplace: string;
  repo: string;
}

export interface Registration {
  known: string;
  updated: boolean;
}

/**
 * Claude Code installs through the `claude` CLI from the marketplace itself, so
 * this harness needs no plugin source - and its job is almost all policy:
 * which name the marketplace is filed under, whether a failure means the local
 * copy is stale or the plugin is absent, and which scope an answer is about.
 * Spelling the argv is `infrastructure/claude-cli.ts`.
 */
export class ClaudeHarness implements Harness {
  readonly name: HarnessName = 'claude';
  readonly title = TITLES.claude;
  readonly needsSource = false;

  detect(opts?: HarnessOpts): boolean {
    return Boolean(this.binary(opts));
  }

  location(): string {
    return 'claude on PATH';
  }

  private binary(opts?: HarnessOpts): string | null {
    return findClaude(opts?.env);
  }

  private cliFor(claude: string, opts?: HarnessOpts): ClaudeCli {
    return claudeCli(claude, opts?.run);
  }

  private async refresh(cli: ClaudeCli, known: string, say: Say): Promise<boolean> {
    const res = await cli.marketplaceUpdate(known);
    if (res.code === 0) {
      say({ harness: 'claude', kind: 'marketplace-updated', known });
      return true;
    }
    say({
      harness: 'claude',
      kind: 'marketplace-update-failed',
      known,
      code: res.code,
      detail: tail(res),
    });
    return false;
  }

  // Claude keys a marketplace by the name it had when added, which drifts from
  // the current `name` in marketplace.json; installing under the file's name
  // then fails with a bare "plugin not found in marketplace".
  private async registeredName(cli: ClaudeCli, repo: string): Promise<string | null> {
    const entries = await cli.listMarketplaces();
    const hit = entries?.find((e) => isSameRepo(e, new RepoSlug(repo)));
    return hit && nonEmptyString(hit.name) ? hit.name : null;
  }

  // A marketplace the user added by hand may predate the plugin, so an existing
  // entry is refreshed rather than assumed current.
  private async ensureMarketplace(
    cli: ClaudeCli,
    { marketplace, repo }: MarketplaceIds,
    say: Say,
  ): Promise<Registration> {
    const entries = await cli.listMarketplaces();
    const existing = entries?.find((e) => isSameRepo(e, new RepoSlug(repo)));

    if (existing) {
      const known = nonEmptyString(existing.name) ? existing.name : marketplace;
      if (known !== marketplace) {
        say({ harness: 'claude', kind: 'marketplace-renamed', known, configured: marketplace });
      }
      say({ harness: 'claude', kind: 'marketplace-registered', known });
      await this.refresh(cli, known, say);
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
      say({ harness: 'claude', kind: 'marketplace-registered', known: marketplace });
      await this.refresh(cli, marketplace, say);
      return { known: marketplace, updated: true };
    }

    const added = await cli.marketplaceAdd(repo);
    if (added.code === 0) {
      say({ harness: 'claude', kind: 'marketplace-added', marketplace });
      return { known: (await this.registeredName(cli, repo)) || marketplace, updated: false };
    }

    // `add` failing with nothing listed usually means an older CLI that cannot
    // list as JSON; refresh by the configured name and let the install report.
    say({
      harness: 'claude',
      kind: 'marketplace-add-rejected',
      code: added.code,
      detail: tail(added),
    });
    const res = await cli.marketplaceUpdate(marketplace);
    if (res.code === 0) {
      say({ harness: 'claude', kind: 'marketplace-updated', known: marketplace });
    }
    return { known: marketplace, updated: true };
  }

  /**
   * Memoized per session, promise rather than result, so a failed registration
   * is shared instead of retried for every plugin from that marketplace. The
   * events fire inside the cached promise, with the work, which is what makes
   * three plugins from one marketplace announce one registration and not three.
   */
  ensureMarketplaceOnce(
    cli: ClaudeCli,
    ids: MarketplaceIds,
    session: Session | null | undefined,
    say: Say,
  ): Promise<Registration> {
    if (!session?.marketplaces) {
      return this.ensureMarketplace(cli, ids, say);
    }
    // Case-folded on the repo, like the session's own keys: `isSameRepo` already
    // reads two spellings as one marketplace, so registering it twice would be a
    // second `marketplace add` for something already added.
    const key = `${ids.repo.toLowerCase()}::${ids.marketplace}`;
    let pending = session.marketplaces.get(key);
    if (!pending) {
      pending = this.ensureMarketplace(cli, ids, say);
      session.marketplaces.set(key, pending);
    }
    return pending;
  }

  async install(ctx: HarnessContext, opts?: HarnessOpts): Promise<boolean> {
    const { plugin, marketplace, repo, session } = ctx;
    const say: Say = ctx.listener;
    const claude = this.binary(opts);
    if (!claude) {
      say({ harness: 'claude', kind: 'cli-missing' });
      return false;
    }
    if (!marketplace) {
      say({ harness: 'claude', kind: 'no-marketplace-name', after: 'install' });
      return false;
    }
    const cli = this.cliFor(claude, opts);

    const { known, updated } = await this.ensureMarketplaceOnce(
      cli,
      { marketplace, repo },
      session,
      say,
    );
    const target = `${plugin}@${known}`;

    let res = await cli.pluginInstall(target, SCOPE);
    if (res.code !== 0 && !updated && LOOKS_STALE.test(`${res.stderr || ''}${res.stdout || ''}`)) {
      say({ harness: 'claude', kind: 'plugin-stale', target, known });
      if (await this.refresh(cli, known, say)) res = await cli.pluginInstall(target, SCOPE);
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
    say({ harness: 'claude', kind: 'plugin-installed', target, scope: SCOPE });
    say({ harness: 'claude', kind: 'reload', after: 'install' });
    return true;
  }

  // Claude fails the same way whether the plugin is missing or something went
  // wrong, so its listing decides - on the plugin id alone, since the marketplace
  // half is its own name for it, and only at the scope this tool owns.
  private async isAbsent(cli: ClaudeCli, plugin: string, res: RunResult): Promise<boolean> {
    const rows = await cli.listPlugins();
    if (!rows) {
      // The failure has to be about this plugin, not merely worded like it.
      const text = `${res.stderr || ''}${res.stdout || ''}`;
      return text.includes(plugin) && LOOKS_ABSENT.test(text);
    }
    const ours = (scope: string | null): boolean =>
      !OTHER_SCOPES.has((scope || SCOPE).toLowerCase());
    return !rows.some((r) => r.plugin === plugin && ours(r.scope));
  }

  async uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<UninstallOutcome> {
    const { plugin, marketplace, repo } = ctx;
    const say: Say = ctx.listener;
    const claude = this.binary(opts);
    // A skip, not a failure: Claude Code is not here to fail, and the record
    // stands until a run that can reach it says otherwise.
    if (!claude) {
      say({ harness: 'claude', kind: 'cli-missing' });
      return 'skipped';
    }
    const cli = this.cliFor(claude, opts);
    const known = (await this.registeredName(cli, repo)) || marketplace;
    if (!known) {
      say({ harness: 'claude', kind: 'no-marketplace-name', after: 'uninstall' });
      return 'skipped';
    }
    const target = `${plugin}@${known}`;
    const res = await cli.pluginUninstall(target, SCOPE);
    if (res.code !== 0) {
      // True whether it was never installed or a command removed it and then failed.
      if (await this.isAbsent(cli, plugin, res)) {
        say({ harness: 'claude', kind: 'plugin-absent', plugin, scope: SCOPE });
        return 'absent';
      }
      say({
        harness: 'claude',
        kind: 'plugin-uninstall-failed',
        target,
        code: res.code,
        detail: tail(res),
      });
      return 'failed';
    }
    say({ harness: 'claude', kind: 'plugin-uninstalled', target });
    say({ harness: 'claude', kind: 'reload', after: 'uninstall' });
    return 'removed';
  }
}
