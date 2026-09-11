import { harnesses } from '../harnesses/index.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { UpdatePrompts } from '../prompts/update.js';
import { MarketplaceLabel, type Brand } from '../types/brand.js';
import type { HarnessOpts } from '../types/harness.js';
import type { UpdateReport, UpdatedRow } from '../types/reports.js';
import type { Session } from '../types/session.js';
import { sourceKindOf } from '../types/plugin-source.js';
import { errorMessage } from '../types/util.js';
import { ActionResult } from './action-result.js';
import { InstallAction } from './install.js';

export interface UpdateRequest {
  brand: Brand;
  pathOpts?: HarnessOpts;
}

/**
 * Refresh every recorded plugin. Each row carries its own repo, ref and
 * marketplace, so each gets its own brand rather than the run's - a machine can
 * hold plugins from more than one marketplace, and updating them all against
 * the flags of the moment would move them.
 */
export class UpdateAction {
  /**
   * The session is handed in rather than built here, and its cleanup belongs to
   * whoever built it - the router, the same as for a lone install. One place
   * creates a session and one place disposes of it.
   */
  constructor(
    private readonly prompts: UpdatePrompts,
    private readonly session: Session,
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
      // `unreadable`, not `failed`: the run still exits non-zero and the
      // summary still names the row, but nothing is reported. A record this
      // build cannot read is not an install that went wrong, and the old build
      // sent nothing for one either - it never reached an install to report on.
      rows.push({ outcome: 'unreadable', plugin, error: `cannot update - ${skip.reason}` });
      this.prompts.unreadable(plugin, skip.reason);
    }
    for (const row of elided) {
      this.prompts.unknownTargets(row.plugin, row.targets);
    }

    // One session for every row: three plugins from one marketplace read the
    // registry once and clone it once.
    const { session } = this;
    for (const entry of entries) {
      // A row that did not come from a marketplace has a path or a repository
      // where a marketplace slug would be, so refreshing it is not a registry
      // read at all. Skipped rather than failed: a row that fails every
      // `update` forever is the one thing this command must never produce, and
      // re-running the install re-syncs it.
      const kind = sourceKindOf(entry.repo);
      if (kind !== 'marketplace') {
        rows.push({ outcome: 'skipped', plugin: entry.plugin });
        this.prompts.notFromMarketplace(entry.plugin, kind);
        continue;
      }
      const entryBrand: Brand = Object.freeze({
        ...brand,
        repo: entry.repo || brand.repo,
        ref: entry.ref || brand.ref,
        id: entry.marketplace || brand.id,
      });
      const marketplace = MarketplaceLabel.of(entryBrand);

      const reachable = harnesses.detected(entry.targets, this.pathOpts);
      if (!reachable.length) {
        rows.push({ outcome: 'skipped', plugin: entry.plugin });
        this.prompts.noEditor(entry.plugin);
        continue;
      }

      const install = new InstallAction(this.prompts.installPrompts(), session, this.pathOpts);
      try {
        const result = await this.prompts.collapsed(() =>
          install.execute({
            brand: entryBrand,
            plugin: entry.plugin,
            ref: entry.ref,
            targets: reachable,
            force: true,
            assumeYes: true,
            pathOpts: this.pathOpts,
          }),
        );
        if (result.isFailed()) {
          const error = result.failure?.message ?? 'failed';
          // The action answered rather than threw, so this is the user's to
          // fix - the same reading the action's own `Failure` gets.
          rows.push({
            outcome: 'failed',
            plugin: entry.plugin,
            // The reportable id, not the one the run knew: a row that came from
            // a directory keeps its plugin's name on this machine.
            id: result.report.source?.reportableId(result.report.plugin) ?? null,
            sourceKind: result.report.source?.kind ?? null,
            marketplace,
            report: result.report,
            stage: result.report.stage,
            error,
            errorKind: 'user',
          });
          this.prompts.rowFailed(entry.plugin, error);
          continue;
        }
        rows.push({
          outcome: 'updated',
          plugin: entry.plugin,
          marketplace,
          report: result.report,
        });
        this.prompts.updated(entry.plugin, result.report.targets);
      } catch (err) {
        // A bug in one row is not the other rows' business, and `update` has
        // to be able to finish and say which one it was. `unexpected`,
        // because a throw out of an action is exactly that: catching it here
        // rather than at the command is what once made every failed row read
        // as the user's fault.
        const error = errorMessage(err);
        // No report: the action never returned one. The stage and the id are
        // still readable off the action, which is what the event needs.
        rows.push({
          outcome: 'failed',
          plugin: entry.plugin,
          id: install.source?.reportableId(install.plugin) ?? null,
          sourceKind: install.source?.kind ?? null,
          marketplace,
          report: null,
          stage: install.stage,
          error,
          errorKind: 'unexpected',
        });
        this.prompts.rowFailed(entry.plugin, error);
      }
    }

    const updated = rows.filter((r) => r.outcome === 'updated').map((r) => r.plugin);
    // Both shapes that failed the run, in the order they happened: a row this
    // build could not read is as much a reason to exit 1 as one whose install
    // broke, and the summary names them together.
    const failed = rows
      .filter((r): r is Extract<UpdatedRow, { error: string }> =>
        ['failed', 'unreadable'].includes(r.outcome),
      )
      .map((r) => ({ plugin: r.plugin, error: r.error }));
    this.prompts.summary(updated.length, total, failed);
    const report = { updated, failed, rows };
    // No `Failure`: the grid named every row that failed and the summary
    // counted them, so there is no sentence left for the router to add - the
    // same reason `doctor` answers this way.
    return failed.length ? ActionResult.failed(report) : ActionResult.success(report);
  };
}
