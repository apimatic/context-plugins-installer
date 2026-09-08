import type { ActionResult } from '../actions/action-result.js';
import { InstallAction, type InstallRequest } from '../actions/install.js';
import { InstallPrompts } from '../prompts/install.js';
import { MarketplaceLabel } from '../types/brand.js';
import type { EventSink } from '../types/events/domain-event.js';
import { PluginInstallFailedEvent } from '../types/events/plugin-install-failed.js';
import { PluginInstalledEvent } from '../types/events/plugin-installed.js';
import type { PluginId } from '../types/ids/plugin-id.js';
import type { InstallReport, InstallStage } from '../types/reports.js';
import type { Session } from '../types/session.js';
import type { ErrorKind } from '../types/telemetry.js';

/**
 * One event per editor the plugin went into, then one for a failure - which
 * carries the stage the report was left at rather than any message, because a
 * message could name a path or a plugin the user typed.
 */
export class InstallCommand {
  constructor(private readonly sink: EventSink) {}

  async run(req: InstallRequest, session: Session): Promise<ActionResult<InstallReport>> {
    const prompts = new InstallPrompts(req.pathOpts?.home, req.ask);
    const marketplace = MarketplaceLabel.of(req.brand);
    const action = new InstallAction(prompts, session, req.pathOpts);
    try {
      const result = await action.execute(req);
      const { plugin, targets, targetsExplicit, durationMs } = result.report;
      // An editor can only be on the list once the id validated, so this reads
      // as a guard and is really the type saying that out loud.
      if (plugin) {
        for (const harness of targets) {
          this.sink(
            new PluginInstalledEvent(plugin, harness, marketplace, targetsExplicit, durationMs),
          );
        }
      }
      if (result.isFailed()) this.failed(plugin, marketplace, result.report.stage, 'user');
      return result;
    } catch (err) {
      // A throw from here is a bug, not a problem the user can fix. Both facts
      // it reports come off the action, because there is no report to read.
      this.failed(action.plugin, marketplace, action.stage, 'unexpected');
      throw err;
    }
  }

  private failed(
    plugin: PluginId | null,
    marketplace: MarketplaceLabel,
    stage: InstallStage | null,
    kind: ErrorKind,
  ): void {
    this.sink(new PluginInstallFailedEvent(plugin, marketplace, stage, kind));
  }
}
