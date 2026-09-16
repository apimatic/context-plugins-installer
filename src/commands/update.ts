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
    const result = await new UpdateAction(prompts, session, req.pathOpts).execute(req.brand);
    for (const row of result.report.rows) this.report(row);
    return result;
  }

  private report(row: UpdatedRow): void {
    switch (row.outcome) {
      case 'updated': {
        const { source } = row.report;
        if (!source) return;
        for (const harness of row.report.targets) {
          this.sink(
            new PluginInstalledEvent(
              source.reportableId(),
              harness,
              row.marketplace,
              source.kind,
              row.report.targetsExplicit,
              row.report.durationMs,
            ),
          );
        }
        return;
      }
      case 'failed':
        this.sink(
          new PluginInstallFailedEvent(
            row.id,
            row.marketplace,
            row.sourceKind,
            row.stage,
            row.errorKind,
          ),
        );
        return;
      case 'unreadable':
      case 'unavailable':
      case 'skipped':
        return;
    }
  }
}
