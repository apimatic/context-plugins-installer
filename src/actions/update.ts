import { harnesses } from '../harnesses/index.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import { announceMarketplace } from '../prompts/marketplace.js';
import { createSession } from '../infrastructure/session.js';
import type { UpdatePrompts } from '../prompts/update.js';
import { marketplaceLabel, type Brand } from '../types/brand.js';
import type { HarnessOpts } from '../types/harness.js';
import type { Deps } from '../types/ports.js';
import type { UpdateReport, UpdatedRow } from '../types/reports.js';
import { errorMessage } from '../util.js';
import { ActionResult } from './action-result.js';
import { InstallAction } from './install.js';

export interface UpdateRequest {
  brand: Brand;
  deps?: Deps;
  pathOpts?: HarnessOpts;
}

/**
 * Refresh every recorded plugin. Each row carries its own repo, ref and
 * marketplace, so each gets its own brand rather than the run's - a machine can
 * hold plugins from more than one marketplace, and updating them all against
 * the flags of the moment would move them.
 */
export class UpdateAction {
  constructor(
    private readonly prompts: UpdatePrompts,
    private readonly deps: Deps = {},
    private readonly pathOpts?: HarnessOpts,
  ) {}

  readonly execute = async (brand: Brand): Promise<ActionResult<UpdateReport>> => {
    const {
      plugins: entries,
      ignored,
      elided,
    } = openManifest(paths.manifestPath(this.pathOpts)).read();
    if (!entries.length && !ignored.length) {
      this.prompts.nothingToUpdate();
      return ActionResult.success({ updated: [], failed: [], rows: [] });
    }

    const rows: UpdatedRow[] = [];
    const total = entries.length + ignored.length;
    this.prompts.intro(
      total,
      [...entries, ...ignored].map((e) => e.plugin || ''),
    );

    for (const skip of ignored) {
      const plugin = skip.plugin || '(unreadable entry)';
      const error = `cannot update - ${skip.reason}`;
      rows.push({ plugin, marketplace: null, report: null, stage: null, error, outcome: 'failed' });
      this.prompts.unreadable(plugin, skip.reason);
    }
    for (const row of elided) {
      this.prompts.unknownTargets(row.plugin, row.targets);
    }

    // One session for every row: three plugins from one marketplace read the
    // registry once and clone it once.
    const session = createSession({ deps: this.deps, notify: announceMarketplace });
    try {
      for (const entry of entries) {
        const entryBrand: Brand = Object.freeze({
          ...brand,
          repo: entry.repo || brand.repo,
          ref: entry.ref || brand.ref,
          id: entry.marketplace || brand.id,
        });
        const marketplace = marketplaceLabel(entryBrand);

        const reachable = harnesses.detected(entry.targets, this.pathOpts);
        if (!reachable.length) {
          rows.push({
            plugin: entry.plugin,
            marketplace,
            report: null,
            stage: null,
            error: null,
            outcome: 'skipped',
          });
          this.prompts.noEditor(entry.plugin);
          continue;
        }

        const install = new InstallAction(
          this.prompts.installPrompts(),
          session,
          this.deps,
          this.pathOpts,
        );
        try {
          const result = await this.prompts.collapsed(() =>
            install.execute({
              brand: entryBrand,
              plugin: entry.plugin,
              ref: entry.ref,
              targets: reachable,
              force: true,
              assumeYes: true,
              deps: this.deps,
              pathOpts: this.pathOpts,
            }),
          );
          if (result.isFailed()) {
            const error = result.failure?.message ?? 'failed';
            rows.push({
              plugin: entry.plugin,
              marketplace,
              report: result.report,
              stage: result.report.stage,
              error,
              outcome: 'failed',
            });
            this.prompts.rowFailed(entry.plugin, error);
            continue;
          }
          rows.push({
            plugin: entry.plugin,
            marketplace,
            report: result.report,
            stage: result.report.stage,
            error: null,
            outcome: 'updated',
          });
          this.prompts.updated(entry.plugin, result.report.targets);
        } catch (err) {
          // A bug in one row is not the other rows' business, and `update` has
          // to be able to finish and say which one it was.
          const error = errorMessage(err);
          // No report: the action never returned one. The stage is still
          // readable, which is what the failure event needs.
          rows.push({
            plugin: entry.plugin,
            marketplace,
            report: null,
            stage: install.stage,
            error,
            outcome: 'failed',
          });
          this.prompts.rowFailed(entry.plugin, error);
        }
      }
    } finally {
      await session.cleanup();
    }

    const updated = rows.filter((r) => r.outcome === 'updated').map((r) => r.plugin);
    const failed = rows
      .filter((r) => r.outcome === 'failed')
      .map((r) => ({ plugin: r.plugin, error: r.error ?? 'failed' }));
    this.prompts.summary(updated.length, total, failed);
    return ActionResult.success({ updated, failed, rows });
  };
}
