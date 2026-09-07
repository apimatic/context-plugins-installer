import type { ActionResult } from '../actions/action-result.js';
import { UpdateAction, type UpdateRequest } from '../actions/update.js';
import { UpdatePrompts } from '../prompts/update.js';
import { PluginId } from '../types/ids/plugin-id.js';
import type { UpdateReport, UpdatedRow } from '../types/reports.js';
import { EVENTS, type TrackFn } from '../types/telemetry.js';

/**
 * `update` is one install per recorded plugin, so it reports the same events -
 * one per editor a row went into, and one for a row that failed, each labelled
 * with that row's own marketplace rather than the run's.
 */
export class UpdateCommand {
  constructor(private readonly track: TrackFn) {}

  async run(req: UpdateRequest): Promise<ActionResult<UpdateReport>> {
    const prompts = new UpdatePrompts(req.pathOpts?.home);
    const result = await new UpdateAction(prompts, req.deps, req.pathOpts).execute(req.brand);
    for (const row of result.report.rows) this.report(row);
    return result;
  }

  private report(row: UpdatedRow): void {
    const marketplace = row.marketplace ?? 'custom';
    if (row.outcome === 'updated' && row.report) {
      for (const harness of row.report.targets) {
        this.track(EVENTS.installed, {
          plugin: row.report.plugin,
          harness,
          marketplace,
          targets_explicit: row.report.targetsExplicit,
          duration_ms: row.report.durationMs,
        });
      }
      return;
    }
    // A row with no editor on this machine is not a failure: nothing was asked
    // of it, so there is nothing to report either.
    if (row.outcome !== 'failed') return;
    this.track(EVENTS.installFailed, {
      plugin: PluginId.create(row.plugin)?.toString() ?? null,
      marketplace,
      stage: row.stage,
      error_kind: 'user',
    });
  }
}
