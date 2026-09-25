import { codexCli, findCodex, type CodexCli } from '../infrastructure/codex-cli.js';
import { exists } from '../infrastructure/file-system.js';
import * as paths from '../infrastructure/paths.js';
import { processRunner } from '../infrastructure/process-runner.js';
import { BIN } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import {
  TITLES,
  type CodexEvent,
  type Harness,
  type HarnessContext,
  type HarnessListener,
  type HarnessName,
  type HarnessOpts,
  type InstallOutcome,
  type MarketplaceListing,
  type UninstallOutcome,
} from '../types/harness.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type {
  DirectoryMarketplace,
  MarketplaceOrigin,
  NamedMarketplace,
} from '../types/marketplace-origin.js';
import type { ProcessRunner, RunResult } from '../types/ports.js';
import { err, ok, type Result } from '../types/result.js';
import type { Session } from '../types/session.js';
import { isPlainObject, nonEmptyString } from '../types/util.js';

/** This harness's half of the listener, as in the Claude harness. */
type Say = (event: CodexEvent) => void;

const tail = (res: RunResult): string =>
  (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' ').trim();

const output = (res: RunResult): string => `${res.stderr || ''}${res.stdout || ''}`;

// What Codex says for a plugin its snapshot of the marketplace does not list,
// whether the snapshot is stale or the plugin does not exist; this only decides
// whether an upgrade is worth one retry.
const LOOKS_STALE = /not found in marketplace/i;

// A Codex from before `codex plugin` existed (0.100.0 and older, measured) reads
// `plugin` as a prompt and refuses the rest of the command line in clap's words.
// Named words only, so a real refusal from a Codex that has plugins is not
// mistaken for this.
const NO_PLUGIN_COMMAND =
  /unexpected argument '(marketplace|list|add|remove|upgrade)' found|unrecognized subcommand '(marketplace|list|add|remove|upgrade)'/i;

// Codex reports a local marketplace's source with Windows' verbatim prefix
// (`\\?\C:\...`), which names the same place as the path without it.
const unverbatim = (at: string): string => at.replace(/^\\\\\?\\/, '');

/** A git marketplace lists `{ marketplaceSource: { sourceType, source } }`; a local one only `root`. */
const sourceOf = (entry: MarketplaceListing): unknown =>
  isPlainObject(entry.marketplaceSource) ? entry.marketplaceSource.source : undefined;

const isSameOrigin = (entry: MarketplaceListing, origin: MarketplaceOrigin): boolean => {
  if (origin.kind === 'directory') {
    return [entry.root, sourceOf(entry)].some(
      (at) => nonEmptyString(at) && origin.dir.samePlace(unverbatim(at)),
    );
  }
  const from = RepoSlug.fromText(sourceOf(entry));
  return Boolean(from?.matches(new RepoSlug(origin.repo)));
};

const addressOf = (origin: MarketplaceOrigin): string =>
  origin.kind === 'repo' ? origin.repo : origin.dir.toString();

/** Where a same-named marketplace comes from, for the message that refuses it. */
const whereFrom = (entry: MarketplaceListing): string => {
  const source = sourceOf(entry);
  if (nonEmptyString(source)) return source;
  return nonEmptyString(entry.root) ? entry.root : 'somewhere else';
};

export interface CodexRegistration {
  known: string;
  /** Whether the snapshot is current, so a missing plugin is not worth an upgrade. */
  updated: boolean;
}

/**
 * Codex installs through the `codex` CLI from a marketplace it has registered -
 * the same shape as Claude Code, and it reads the same
 * `.claude-plugin/marketplace.json`, so neither the built-in marketplace nor the
 * one generated for a path plugin needs anything written for it. Spelling the
 * argv is `infrastructure/codex-cli.ts`; this is the policy.
 *
 * Two things differ from Claude and shape everything below. A git marketplace
 * is a snapshot Codex refreshes with `marketplace upgrade`, while a local one is
 * read where it lies and cannot be upgraded at all. And `plugin remove`
 * succeeds whether or not the plugin was installed, so it cannot tell `removed`
 * from `absent`: what Codex held is read before the removal, from its listing
 * and from the cache folder a removal deletes.
 */
export class CodexHarness implements Harness {
  readonly name: HarnessName = 'codex';
  readonly title = TITLES.codex;
  readonly needsSource = false;

  detect(opts?: HarnessOpts): boolean {
    return Boolean(this.binary(opts));
  }

  location(): string {
    return 'codex on PATH';
  }

  private runner(opts?: HarnessOpts): ProcessRunner {
    return opts?.runner ?? processRunner(opts?.env);
  }

  private binary(opts?: HarnessOpts): string | null {
    return findCodex(this.runner(opts));
  }

  private cliFor(codex: string, opts?: HarnessOpts): CodexCli {
    return codexCli(codex, this.runner(opts));
  }

  private async upgrade(cli: CodexCli, known: string, say: Say): Promise<boolean> {
    const res = await cli.marketplaceUpgrade(known);
    if (res.code === 0) {
      say({ harness: 'codex', kind: 'marketplace-upgraded', known });
      return true;
    }
    say({
      harness: 'codex',
      kind: 'marketplace-upgrade-failed',
      known,
      code: res.code,
      detail: tail(res),
    });
    return false;
  }

  // Codex keys a marketplace by the name in its marketplace.json when it was
  // added, which can drift from the name the file carries today.
  private async registeredName(cli: CodexCli, origin: MarketplaceOrigin): Promise<string | null> {
    const entries = await cli.listMarketplaces();
    const hit = entries?.find((e) => isSameOrigin(e, origin));
    return hit && nonEmptyString(hit.name) ? hit.name : null;
  }

  private async ensureMarketplace(
    cli: CodexCli,
    origin: NamedMarketplace,
    say: Say,
  ): Promise<Result<CodexRegistration | 'unsupported', Failure>> {
    const { name: marketplace } = origin;
    const entries = await cli.listMarketplaces();
    const existing = entries?.find((e) => isSameOrigin(e, origin));

    if (existing) {
      const known = nonEmptyString(existing.name) ? existing.name : marketplace;
      if (known !== marketplace) {
        say({ harness: 'codex', kind: 'marketplace-renamed', known, configured: marketplace });
      }
      say({ harness: 'codex', kind: 'marketplace-registered', known });
      // A local marketplace is read where it lies; only a git one has a
      // snapshot to refresh, and `upgrade` refuses anything else.
      const updated = origin.kind === 'directory' || (await this.upgrade(cli, known, say));
      return ok({ known, updated });
    }

    // Every Codex entry says where it came from, so a same-named one that is
    // not this origin is somebody else's, and installing into it would install
    // their plugin of the same name.
    const clash = entries?.find((e) => e.name === marketplace);
    if (clash) {
      return err(
        new Failure(
          `Codex already has a marketplace named '${marketplace}', from ${whereFrom(clash)} rather than ${addressOf(origin)}.`,
          `Remove it with \`codex plugin marketplace remove ${marketplace}\`, then run this again.`,
        ),
      );
    }

    // `add` of a source Codex already holds succeeds, so an unreadable listing
    // costs nothing here - and a refusal is a real one.
    const added = await cli.marketplaceAdd(addressOf(origin));
    // Not a refusal to fix but a Codex that cannot take plugins at all: a skip,
    // so the editors already installed this run are still recorded.
    if (added.code !== 0 && NO_PLUGIN_COMMAND.test(output(added))) return ok('unsupported');
    if (added.code !== 0) {
      return err(
        new Failure(
          `Codex would not register '${marketplace}' from ${addressOf(origin)}: ${tail(added)}`.trim(),
          `Run \`codex plugin marketplace add ${addressOf(origin)}\` to see what it refuses.`,
        ),
      );
    }
    say({ harness: 'codex', kind: 'marketplace-added', marketplace });
    return ok({ known: (await this.registeredName(cli, origin)) || marketplace, updated: true });
  }

  /**
   * Memoized per session like Claude's, in a map of Codex's own: the two CLIs
   * file one marketplace under names of their own, and neither may be handed
   * the other's answer. The promise is cached, so an `unsupported` is found
   * once per run rather than once per plugin.
   */
  ensureMarketplaceOnce(
    cli: CodexCli,
    origin: NamedMarketplace,
    session: Session | null | undefined,
    listener: HarnessListener,
  ): Promise<Result<CodexRegistration | 'unsupported', Failure>> {
    if (!session?.codexMarketplaces) return this.ensureMarketplace(cli, origin, listener);
    const key = origin.key();
    let pending = session.codexMarketplaces.get(key);
    if (!pending) {
      pending = this.ensureMarketplace(cli, origin, listener);
      session.codexMarketplaces.set(key, pending);
    }
    return pending;
  }

  async install(ctx: HarnessContext, opts?: HarnessOpts): Promise<Result<InstallOutcome, Failure>> {
    const { plugin, origin, session } = ctx;
    const say: Say = ctx.listener;
    const codex = this.binary(opts);
    if (!codex) {
      say({ harness: 'codex', kind: 'cli-missing' });
      return ok('skipped');
    }
    if (!origin.hasName()) {
      say({ harness: 'codex', kind: 'no-marketplace-name', after: 'install' });
      return ok('skipped');
    }
    const cli = this.cliFor(codex, opts);

    const registered = await this.ensureMarketplaceOnce(cli, origin, session, ctx.listener);
    if (!registered.ok) return registered;
    if (registered.value === 'unsupported') {
      say({ harness: 'codex', kind: 'plugins-unsupported' });
      return ok('skipped');
    }
    const { known, updated } = registered.value;
    const target = `${plugin}@${known}`;

    // No removal first, unlike Claude: `plugin add` re-copies the plugin into
    // its cache even when the manifest version did not move.
    let res = await cli.pluginAdd(target);
    if (res.code !== 0 && !updated && LOOKS_STALE.test(output(res))) {
      say({ harness: 'codex', kind: 'plugin-stale', target, known });
      if (await this.upgrade(cli, known, say)) res = await cli.pluginAdd(target);
    }
    if (res.code !== 0) {
      return err(
        new Failure(
          `codex plugin add ${target} failed (exit ${res.code}). ${tail(res)}`.trim(),
          LOOKS_STALE.test(output(res))
            ? `'${plugin}' is not in marketplace '${known}'. Run \`npx ${BIN} list\` to see what it offers.`
            : undefined,
        ),
      );
    }
    say({ harness: 'codex', kind: 'plugin-installed', target });
    say({ harness: 'codex', kind: 'reload', after: 'install' });
    return ok('installed');
  }

  /**
   * Whether Codex holds the plugin under this marketplace. Either answer is
   * enough: the listing hides a plugin its marketplace no longer offers, while
   * the cache folder is what Codex actually loads and what `remove` deletes.
   * `null` is "could not tell": with the marketplace listing broken too,
   * `known` is a guess, and an empty cache under a guessed name proves nothing.
   */
  private async holds(
    cli: CodexCli,
    plugin: string,
    known: string,
    nameSettled: boolean,
    opts?: HarnessOpts,
  ): Promise<boolean | null> {
    if (exists(paths.codexPluginCacheDir(known, plugin, opts))) return true;
    const rows = await cli.listPlugins();
    if (rows) return rows.some((r) => r.plugin === plugin && r.marketplace === known);
    return nameSettled ? false : null;
  }

  async uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<UninstallOutcome> {
    const { plugin, origin } = ctx;
    const say: Say = ctx.listener;
    const codex = this.binary(opts);
    // A skip, not a failure: Codex is not here to fail, and the record stands
    // until a run that can reach it says otherwise.
    if (!codex) {
      say({ harness: 'codex', kind: 'cli-missing' });
      return 'skipped';
    }
    const cli = this.cliFor(codex, opts);
    // The listing itself, not just the name it resolves: whether it answered
    // decides what an empty cache is allowed to mean below. A listing that
    // answered without our entry has itself answered - the marketplace is not
    // registered, so nothing under it is loaded.
    const entries = await cli.listMarketplaces();
    const hit = entries?.find((e) => isSameOrigin(e, origin));
    const known = (hit && nonEmptyString(hit.name) ? hit.name : null) || origin.name;
    if (!known) {
      say({ harness: 'codex', kind: 'no-marketplace-name', after: 'uninstall' });
      return 'skipped';
    }
    const target = `${plugin}@${known}`;

    // Read before the removal: afterwards both answers are "not here".
    const had = await this.holds(cli, plugin, known, entries !== null, opts);
    const res = await cli.pluginRemove(target);
    // Could not look, not looked-and-failed: this Codex never held a plugin.
    if (res.code !== 0 && NO_PLUGIN_COMMAND.test(output(res))) {
      say({ harness: 'codex', kind: 'plugins-unsupported' });
      return 'skipped';
    }
    if (res.code !== 0) {
      say({
        harness: 'codex',
        kind: 'plugin-uninstall-failed',
        target,
        code: res.code,
        detail: tail(res),
      });
      return 'failed';
    }
    // A removal that reported success and left the files is not one.
    const dir = paths.codexPluginCacheDir(known, plugin, opts);
    if (exists(dir)) {
      say({ harness: 'codex', kind: 'plugin-left-behind', target, dir });
      return 'failed';
    }
    // `remove` exits 0 whether or not anything was there, so with the question
    // above unanswered this run has established nothing: `absent` is a positive
    // finding that clears the record, and an unanswered question is a skip.
    if (had === null) {
      say({ harness: 'codex', kind: 'plugin-unverified', target });
      return 'skipped';
    }
    if (!had) {
      say({ harness: 'codex', kind: 'plugin-absent', target });
      return 'absent';
    }
    say({ harness: 'codex', kind: 'plugin-uninstalled', target });
    say({ harness: 'codex', kind: 'reload', after: 'uninstall' });
    return 'removed';
  }

  /**
   * By the name Codex filed it under, which the listing resolves - the name in
   * marketplace.json can drift after registration, and removing by today's
   * name would miss the entry and leave it dangling. A listing that answers
   * without an entry of ours removes nothing: a same-named entry from another
   * directory is not ours to remove. Only a listing that cannot answer falls
   * back to the configured name, because a registration whose directory has
   * gone is exactly what stops Codex listing anything - so a failed listing is
   * no reason to keep it.
   */
  async forgetMarketplace(
    origin: DirectoryMarketplace,
    listener: HarnessListener,
    opts?: HarnessOpts,
  ): Promise<void> {
    const codex = this.binary(opts);
    if (!codex) return;
    const cli = this.cliFor(codex, opts);
    const entries = await cli.listMarketplaces();
    const entry = entries?.find((e) => isSameOrigin(e, origin));
    if (entries && !entry) return;
    const known = entry && nonEmptyString(entry.name) ? entry.name : origin.name;
    const dropped = await cli.marketplaceRemove(known);
    if (dropped.code === 0) {
      listener({ harness: 'codex', kind: 'marketplace-removed', known });
    }
  }
}
