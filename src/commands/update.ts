import type { ActionResult } from '../actions/action-result.js';
import { UpdateAction, type UpdateRequest } from '../actions/update.js';
import { UpdatePrompts } from '../prompts/update.js';
import type { EventSink } from '../types/events/domain-event.js';
import { PluginInstallFailedEvent } from '../types/events/plugin-install-failed.js';
import { PluginInstalledEvent } from '../types/events/plugin-installed.js';
import type { UpdateReport, UpdatedRow } from '../types/reports.js';
import type { Session } from '../types/session.js';

/**
 * `update` is one install per recorded plugin, so it reports the same events -
 * one per editor a row went into, and one for a row that failed, each labelled
 * with that row's own marketplace rather than the run's.
 */
export class UpdateCommand {
  constructor(private readonly sink: EventSink) {}

  async run(req: UpdateRequest, session: Session): Promise<ActionResult<UpdateReport>> {
    const prompts = new UpdatePrompts(req.pathOpts?.home);
    const result = await new UpdateAction(prompts, session, req.deps, req.pathOpts).execute(
      req.brand,
    );
    for (const row of result.report.rows) this.report(row);
    return result;
  }

  /**
   * Which events one row is worth, decided by its shape alone. The two silent
   * arms are silent for different reasons: a row this build cannot read is a
   * record problem rather than an install that failed, and a row with no editor
   * on this machine was asked nothing at all.
   */
  private report(row: UpdatedRow): void {
    switch (row.outcome) {
      case 'updated':
        for (const harness of row.report.targets) {
          if (!row.report.plugin) continue;
          this.sink(
            new PluginInstalledEvent(
              row.report.plugin,
              harness,
              row.marketplace,
              row.report.targetsExplicit,
              row.report.durationMs,
            ),
          );
        }
        return;
      case 'failed':
        this.sink(new PluginInstallFailedEvent(row.id, row.marketplace, row.stage, row.errorKind));
        return;
      case 'unreadable':
      case 'skipped':
        return;
    }
  }
}
