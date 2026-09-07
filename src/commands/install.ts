import type { ActionResult } from '../actions/action-result.js';
import { InstallAction, type InstallRequest } from '../actions/install.js';
import { InstallPrompts } from '../prompts/install.js';
import { marketplaceLabel } from '../types/brand.js';
import { PluginId } from '../types/ids/plugin-id.js';
import type { InstallReport } from '../types/reports.js';
import type { Session } from '../types/session.js';
import { EVENTS, type TrackFn } from '../types/telemetry.js';

/**
 * One event per editor the plugin went into, then one for a failure - which
 * carries the stage the report was left at rather than any message, because a
 * message could name a path or a plugin the user typed.
 */
export class InstallCommand {
  constructor(private readonly track: TrackFn) {}

  async run(req: InstallRequest, session: Session): Promise<ActionResult<InstallReport>> {
    const prompts = new InstallPrompts(req.pathOpts?.home, req.deps?.confirm);
    const marketplace = marketplaceLabel(req.brand);
    const action = new InstallAction(prompts, session, req.deps, req.pathOpts);
    try {
      const result = await action.execute(req);
      for (const harness of result.report.targets) {
        this.track(EVENTS.installed, {
          plugin: result.report.plugin,
          harness,
          marketplace,
          targets_explicit: result.report.targetsExplicit,
          duration_ms: result.report.durationMs,
        });
      }
      if (result.isFailed()) this.fireFailure(req.plugin, marketplace, result.report.stage, 'user');
      return result;
    } catch (err) {
      // A throw from here is a bug, not a problem the user can fix.
      this.fireFailure(req.plugin, marketplace, action.stage, 'unexpected');
      throw err;
    }
  }

  private fireFailure(plugin: string, marketplace: string, stage: string, kind: string): void {
    this.track(EVENTS.installFailed, {
      plugin: PluginId.create(plugin)?.toString() ?? null,
      marketplace,
      stage,
      error_kind: kind,
    });
  }
}
