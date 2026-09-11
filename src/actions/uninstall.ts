import { resolvePlugin } from '../application/plugin-resolution.js';
import { resolveTargets } from '../application/target-selection.js';
import { decideUninstall, uninstallLines } from '../application/uninstall-decision.js';
import { harnesses } from '../harnesses/index.js';
import { localMarketplace } from '../infrastructure/local-marketplace.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { UninstallPrompts } from '../prompts/uninstall.js';
import { BIN, type Brand } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import {
  titlesOf,
  type HarnessName,
  type HarnessOpts,
  type UninstallOutcome,
} from '../types/harness.js';
import { PluginId } from '../types/ids/plugin-id.js';
import { DirectoryPath } from '../types/file/paths.js';
import { RepoMarketplace, type MarketplaceOrigin } from '../types/marketplace-origin.js';
import {
  LocalSource,
  MarketplaceSource,
  localDirOf,
  type PluginSource,
} from '../types/plugin-source.js';
import type { RegistryClient } from '../types/ports.js';
import type { UninstallResult } from '../types/reports.js';
import { errorMessage, nonEmptyString } from '../types/util.js';
import { ActionResult } from './action-result.js';

export interface UninstallRequest {
  brand: Brand;
  plugin: string;
  targets?: readonly string[] | null;
  /** Clear the record even for editors that could not confirm the removal. */
  force?: boolean;
  pathOpts?: HarnessOpts;
}

/**
 * Take a plugin out of every editor asked for, and correct the record to match
 * what actually happened. Two invariants live here and nowhere else:
 *
 * - Every editor is visited even if one throws, so a partial failure neither
 *   hides the others nor loses the removals already done.
 * - The record and every line of the summary come from one `decideUninstall`
 *   over the outcomes, so the two cannot disagree about what happened.
 */
export class UninstallAction {
  /**
   * Which plugin this run is about, once validated. The command's catch reads
   * it: a throw still has to report what it was doing, and the report it would
   * otherwise read is the one that never got built.
   */
  private id: PluginId | null = null;

  private from: PluginSource | null = null;

  get plugin(): PluginId | null {
    return this.id;
  }

  /** The row's own source, for the command's catch to report on. */
  get source(): PluginSource | null {
    return this.from;
  }

  constructor(
    private readonly prompts: UninstallPrompts,
    private readonly registry: RegistryClient,
    private readonly pathOpts?: HarnessOpts,
  ) {}

  /**
   * Where the marketplace lives and what Claude Code knows it by. The repo is
   * always the run's; only the name has to be found, and a row's own recorded
   * name is what keeps this offline. A lookup is needed only when there is
   * none - and with a row to correct, a failed lookup must not block cleaning
   * it up, so the origin comes back nameless and the harness asks the CLI.
   */
  private async marketplaceFor(
    brand: Brand,
    plugin: string,
    recorded: Record<string, unknown> | null,
    want: readonly HarnessName[],
    local: boolean,
  ): Promise<{ origin: MarketplaceOrigin } | { failure: Failure }> {
    // A row installed from a directory is addressed through the marketplace this
    // tool generated for it, and there is no registry anywhere to look up.
    if (local) return { origin: localMarketplace(this.pathOpts) };
    const at = (name: string | null): { origin: MarketplaceOrigin } => ({
      origin: new RepoMarketplace(brand.repo, name),
    });
    const known =
      brand.id || (recorded && nonEmptyString(recorded.marketplace) ? recorded.marketplace : null);
    if (known || !want.includes('claude')) return at(known);

    const read = await this.registry.readRegistry({
      repo: brand.repo,
      ref: brand.ref,
      notify: this.prompts.marketplaceListener,
    });
    const resolved = read.ok
      ? resolvePlugin(read.value, { plugin, repo: brand.repo, ref: brand.ref })
      : read;
    if (resolved.ok) return { origin: resolved.value.origin };
    // With no record there is nothing to correct, so the lookup error and its
    // suggestion are the useful answer.
    if (!recorded) return { failure: resolved.error };
    this.prompts.marketplaceUnknown(plugin, resolved.error);
    return at(null);
  }

  readonly execute = async (req: UninstallRequest): Promise<ActionResult<UninstallResult>> => {
    const { brand, force = false } = req;
    // A function, not a value: the arms after the id is validated report which
    // plugin the run was about, and the one before it has nothing to report.
    const nothing = (): UninstallResult => ({
      plugin: this.id,
      source: this.from,
      targets: [],
      failed: [],
    });

    const id = PluginId.parse(req.plugin);
    if (!id.ok) return ActionResult.failed(nothing(), id.error);
    this.id = id.value;
    const plugin = id.value.toString();

    const records = openManifest(paths.manifestPath(this.pathOpts));
    // One read, and the raw row: uninstall must also clear rows the sanitized
    // view hides, and their recorded marketplace is what keeps Claude offline.
    const { key, row: recorded } = records.locate(plugin, brand.repo);
    const dir = localDirOf(key.repo);
    // Rebuilt from the key so the command can ask it the same two questions an
    // install asks: which kind to report, and whether the id may be reported at
    // all. A plugin removed from a directory withholds the name that directory
    // gave it, exactly as installing it did.
    this.from =
      dir === null
        ? new MarketplaceSource(id.value, String(key.repo ?? brand.repo), brand.ref)
        : new LocalSource(new DirectoryPath(dir));

    const targets = resolveTargets(req.targets);
    if (!targets.ok) return ActionResult.failed(nothing(), targets.error);
    const want = targets.value;

    const found = await this.marketplaceFor(brand, plugin, recorded, want, dir !== null);
    if ('failure' in found) return ActionResult.failed(nothing(), found.failure);

    this.prompts.intro(plugin, brand, want);

    // One entry per editor visited. `decideUninstall` derives everything the
    // record and the summary say from exactly this, so the two cannot disagree.
    const outcomes = new Map<HarnessName, UninstallOutcome>();
    for (const name of want) {
      const harness = harnesses.byName(name);
      this.prompts.beginHarness(harness.title);
      try {
        outcomes.set(
          name,
          await harness.uninstall(
            {
              plugin,
              origin: found.origin,
              listener: this.prompts.harnessListener,
            },
            this.pathOpts,
          ),
        );
      } catch (err) {
        // One editor's I/O failure is not the others' business.
        this.prompts.harnessThrew(harness.title, errorMessage(err));
        outcomes.set(name, 'failed');
      }
    }

    const decision = decideUninstall({ recorded: recorded ?? null, outcomes, want, force });
    // Not in a `finally`: a write failure on the success path must not pass
    // silently as one more thing that went wrong.
    records.applyUninstall(key, decision);

    this.prompts.summary(uninstallLines(decision, { plugin, bin: BIN }));

    const report: UninstallResult = {
      plugin: id.value,
      source: this.from,
      targets: decision.removed,
      failed: decision.failed,
    };
    // Asked and went wrong is not a clean uninstall, however much else worked -
    // and the summary above has already said what did.
    if (!report.failed.length) return ActionResult.success(report);
    return ActionResult.failed(
      report,
      new Failure(
        `Could not uninstall '${plugin}' from ${titlesOf(report.failed)}.`,
        'Close the editor if it is running, then try again - or --verbose for detail.',
      ),
    );
  };
}
