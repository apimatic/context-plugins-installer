import { harnesses } from '../harnesses/index.js';
import { exists } from '../infrastructure/file-system.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { UpdatePrompts } from '../prompts/update.js';
import { MarketplaceLabel, type Brand } from '../types/brand.js';
import type { HarnessOpts } from '../types/harness.js';
import { PluginId } from '../types/ids/plugin-id.js';
import type { ManifestEntry } from '../types/installed-record.js';
import type { UpdateReport, UpdatedRow } from '../types/reports.js';
import type { Session } from '../types/session.js';
import { restoreSource, sourceKindOf, type PluginSource } from '../types/plugin-source.js';
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

  /**
   * The source a row restores to, or why it cannot be refreshed at all.
   *
   * `null` is a marketplace row: its key is a repository, the registry read is
   * what resolves it, and nothing about that path changes. The other two carry
   * where they came from in the key itself, so refreshing them is re-running
   * the install they came from rather than a registry read.
   *
   * Only a directory that is gone answers with a reason. A repository that
   * cannot be read is left to fail like any other install: a 404 and an outage
   * are not distinguishable here, and reporting "your plugin's source is gone"
   * during a GitHub outage is worse than reporting the outage.
   */
  private sourceFor(
    entry: ManifestEntry,
    brand: Brand,
  ): { source: PluginSource | null } | { reason: string } {
    if (sourceKindOf(entry.repo) === 'marketplace') return { source: null };

    const id = PluginId.parse(entry.plugin);
    // Only a hand edit reaches this - `recordInstall` writes a validated id -
    // but the record is a file a user can open, and a row this build cannot
    // even address is still not a reason to fail every `update` for ever.
    if (!id.ok) return { reason: 'the name on its record is not one this build can read' };

    const source = restoreSource(entry.repo, {
      plugin: id.value,
      ref: entry.ref || brand.ref,
      rules: paths.pathContext(this.pathOpts).rules,
    });
    // Moving a plugin folder is an ordinary day for whoever is writing one, so
    // it is the case this arm exists for. A folder that is still there but is
    // no longer a plugin is a failure like any other: something went wrong
    // with a source that is present, and the install says what.
    if (source.kind === 'local' && !exists(source.dir)) {
      return { reason: 'the folder it was installed from is gone' };
    }
    return { source };
  }

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
      // Where the row came from, which decides almost everything below: a
      // marketplace row is refreshed against its own registry, and the other
      // two carry everything they need in the key itself.
      const from = this.sourceFor(entry, brand);
      if ('reason' in from) {
        rows.push({ outcome: 'unavailable', plugin: entry.plugin, reason: from.reason });
        this.prompts.unavailable(entry.plugin, from.reason);
        continue;
      }
      const { source } = from;
      // A prefixed key is not a repository, so only a marketplace row moves the
      // brand onto its own. The other kinds never reach the code that reads it.
      const entryBrand: Brand =
        source === null
          ? Object.freeze({
              ...brand,
              repo: entry.repo || brand.repo,
              ref: entry.ref || brand.ref,
              id: entry.marketplace || brand.id,
            })
          : brand;
      // `forSource` rather than `of`, for the reason it exists: a row that came
      // from a path or a repository must not be labelled with the built-in
      // marketplace, and one command answering that for itself is how the
      // question comes to have two answers.
      const marketplace = MarketplaceLabel.forSource(source, entryBrand);

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
            // The row's own source, not its id re-read against the run's
            // marketplace - which for a path row would install a different
            // plugin that happens to share a name.
            plugin: source ?? entry.plugin,
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
            id: result.report.source?.reportableId() ?? null,
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
          id: install.source?.reportableId() ?? null,
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
