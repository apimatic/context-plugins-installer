import { claudeCli, findClaude, type ClaudeCli } from '../infrastructure/claude-cli.js';
import { unstageLocalPlugin } from '../infrastructure/local-marketplace.js';
import { processRunner } from '../infrastructure/process-runner.js';
import { BIN } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import {
  TITLES,
  type ClaudeEvent,
  type Harness,
  type HarnessContext,
  type HarnessListener,
  type HarnessName,
  type HarnessOpts,
  type InstallOutcome,
  type MarketplaceListing,
  type UninstallOutcome,
} from '../types/harness.js';
import type { DirectoryPath } from '../types/file/paths.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type { MarketplaceOrigin, NamedMarketplace } from '../types/marketplace-origin.js';
import type { ProcessRunner, RunResult } from '../types/ports.js';
import { err, ok, type Result } from '../types/result.js';
import type { Session } from '../types/session.js';
import { isPlainObject, nonEmptyString } from '../types/util.js';

/**
 * This harness's half of the listener: it only ever emits Claude events, so the
 * private steps below say so. The one public method takes the whole
 * `HarnessListener` instead, because a caller has to be able to name its type.
 */
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

// A directory marketplace lists as `{ source: 'directory', path, installLocation }`
// - measured against claude 2.1.266.
const isSameDirectory = (entry: MarketplaceListing, dir: DirectoryPath): boolean =>
  [entry.path, entry.installLocation].some((at) => nonEmptyString(at) && dir.samePlace(at));

const isSameOrigin = (entry: MarketplaceListing, origin: MarketplaceOrigin): boolean => {
  if (origin.kind === 'directory') return isSameDirectory(entry, origin.dir);
  const repo = new RepoSlug(origin.repo);
  const from = repoOf(entry);
  if (from) return from.matches(repo);
  return JSON.stringify(entry).toLowerCase().includes(repo.toSearchKey());
};

const addressOf = (origin: MarketplaceOrigin): string =>
  origin.kind === 'repo' ? origin.repo : origin.dir.toString();

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

  /**
   * One service for both questions. `HarnessOpts` carries a runner rather than
   * a bare `run`, so the lookup that finds `claude` and the spawn that uses it
   * read the same `PATH` - which is also what lets a test point both at a fake
   * binary with one object.
   */
  private runner(opts?: HarnessOpts): ProcessRunner {
    return opts?.runner ?? processRunner(opts?.env);
  }

  private binary(opts?: HarnessOpts): string | null {
    return findClaude(this.runner(opts));
  }

  private cliFor(claude: string, opts?: HarnessOpts): ClaudeCli {
    return claudeCli(claude, this.runner(opts));
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
  private async registeredName(cli: ClaudeCli, origin: MarketplaceOrigin): Promise<string | null> {
    const entries = await cli.listMarketplaces();
    const hit = entries?.find((e) => isSameOrigin(e, origin));
    return hit && nonEmptyString(hit.name) ? hit.name : null;
  }

  // A marketplace the user added by hand may predate the plugin, so an existing
  // entry is refreshed rather than assumed current.
  private async ensureMarketplace(
    cli: ClaudeCli,
    origin: NamedMarketplace,
    say: Say,
  ): Promise<Result<Registration, Failure>> {
    const { name: marketplace } = origin;
    const entries = await cli.listMarketplaces();
    const existing = entries?.find((e) => isSameOrigin(e, origin));

    if (existing) {
      const known = nonEmptyString(existing.name) ? existing.name : marketplace;
      if (known !== marketplace) {
        say({ harness: 'claude', kind: 'marketplace-renamed', known, configured: marketplace });
      }
      say({ harness: 'claude', kind: 'marketplace-registered', known });
      await this.refresh(cli, known, say);
      return ok({ known, updated: true });
    }

    // A same-named entry from another repo would swallow the install; refuse only
    // when Claude can say where it came from, otherwise treat it as ours.
    const clash = entries?.find((e) => e.name === marketplace);
    if (clash) {
      const from = repoOf(clash);
      if (from) {
        return err(
          new Failure(
            `Claude Code already has a marketplace named '${marketplace}', from ${from} rather than ${origin}.`,
            `Remove it with \`claude plugin marketplace remove ${marketplace}\`, then run this again.`,
          ),
        );
      }
      say({ harness: 'claude', kind: 'marketplace-registered', known: marketplace });
      await this.refresh(cli, marketplace, say);
      return ok({ known: marketplace, updated: true });
    }

    const added = await cli.marketplaceAdd(addressOf(origin));
    if (added.code === 0) {
      say({ harness: 'claude', kind: 'marketplace-added', marketplace });
      return ok({ known: (await this.registeredName(cli, origin)) || marketplace, updated: false });
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
    return ok({ known: marketplace, updated: true });
  }

  /**
   * Memoized per session, the promise rather than what it settles to, so a
   * failed registration is shared instead of retried for every plugin from that
   * marketplace. The events fire inside the cached promise, with the work, which
   * is what makes three plugins from one marketplace announce one registration
   * and not three.
   */
  ensureMarketplaceOnce(
    cli: ClaudeCli,
    origin: NamedMarketplace,
    session: Session | null | undefined,
    listener: HarnessListener,
  ): Promise<Result<Registration, Failure>> {
    if (!session?.marketplaces) {
      return this.ensureMarketplace(cli, origin, listener);
    }
    const key = origin.key();
    let pending = session.marketplaces.get(key);
    if (!pending) {
      pending = this.ensureMarketplace(cli, origin, listener);
      session.marketplaces.set(key, pending);
    }
    return pending;
  }

  async install(ctx: HarnessContext, opts?: HarnessOpts): Promise<Result<InstallOutcome, Failure>> {
    const { plugin, origin, session } = ctx;
    const say: Say = ctx.listener;
    const claude = this.binary(opts);
    if (!claude) {
      say({ harness: 'claude', kind: 'cli-missing' });
      return ok('skipped');
    }
    if (!origin.hasName()) {
      say({ harness: 'claude', kind: 'no-marketplace-name', after: 'install' });
      return ok('skipped');
    }
    const cli = this.cliFor(claude, opts);

    const registered = await this.ensureMarketplaceOnce(cli, origin, session, ctx.listener);
    if (!registered.ok) return registered;
    const { known, updated } = registered.value;
    const target = `${plugin}@${known}`;

    // A plugin is cached under `<marketplace>/<id>/<version>`, so re-installing
    // one whose manifest version did not move copies nothing.
    const replaced =
      origin.kind === 'directory' && (await cli.pluginUninstall(target, SCOPE)).code === 0;

    let res = await cli.pluginInstall(target, SCOPE);
    if (res.code !== 0 && !updated && LOOKS_STALE.test(`${res.stderr || ''}${res.stdout || ''}`)) {
      say({ harness: 'claude', kind: 'plugin-stale', target, known });
      if (await this.refresh(cli, known, say)) res = await cli.pluginInstall(target, SCOPE);
    }
    if (res.code !== 0) {
      return err(
        new Failure(
          `claude plugin install ${target} failed (exit ${res.code}). ${tail(res)}`.trim(),
          replaced
            ? `The previous copy of '${plugin}' was removed first, so Claude Code has none now. Run the same install again once the cause is fixed.`
            : LOOKS_STALE.test(`${res.stderr || ''}${res.stdout || ''}`)
              ? `'${plugin}' is not in marketplace '${known}'. Run \`npx ${BIN} list\` to see what it offers.`
              : undefined,
        ),
      );
    }
    say({ harness: 'claude', kind: 'plugin-installed', target, scope: SCOPE });
    say({ harness: 'claude', kind: 'reload', after: 'install' });
    return ok('installed');
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

  private async unstage(
    cli: ClaudeCli,
    origin: MarketplaceOrigin,
    plugin: string,
    known: string,
    say: Say,
    opts?: HarnessOpts,
  ): Promise<void> {
    if (origin.kind !== 'directory') return;
    const unstaged = unstageLocalPlugin({ plugin }, opts);
    if (!unstaged.ok) {
      say({ harness: 'claude', kind: 'staging-left', detail: unstaged.error.message });
      return;
    }
    if (!unstaged.value.removed) return;
    const dropped = await cli.marketplaceRemove(known);
    if (dropped.code === 0) say({ harness: 'claude', kind: 'marketplace-removed', known });
  }

  async uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<UninstallOutcome> {
    const { plugin, origin } = ctx;
    const say: Say = ctx.listener;
    const claude = this.binary(opts);
    // A skip, not a failure: Claude Code is not here to fail, and the record
    // stands until a run that can reach it says otherwise.
    if (!claude) {
      say({ harness: 'claude', kind: 'cli-missing' });
      return 'skipped';
    }
    const cli = this.cliFor(claude, opts);
    const known = (await this.registeredName(cli, origin)) || origin.name;
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
        await this.unstage(cli, origin, plugin, known, say, opts);
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
    await this.unstage(cli, origin, plugin, known, say, opts);
    say({ harness: 'claude', kind: 'reload', after: 'uninstall' });
    return 'removed';
  }
}
