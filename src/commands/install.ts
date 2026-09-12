import type { ActionResult } from '../actions/action-result.js';
import { InstallAction, type InstallRequest } from '../actions/install.js';
import { InstallPrompts } from '../prompts/install.js';
import { MarketplaceLabel } from '../types/brand.js';
import type { EventSink } from '../types/events/domain-event.js';
import { PluginInstallFailedEvent } from '../types/events/plugin-install-failed.js';
import { PluginInstalledEvent } from '../types/events/plugin-installed.js';
import type { PluginSource, SourceKind } from '../types/plugin-source.js';
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
    const action = new InstallAction(prompts, session, req.pathOpts);
    try {
      const result = await action.execute(req);
      const { source, targets, targetsExplicit, durationMs } = result.report;
      const marketplace = MarketplaceLabel.forSource(source, req.brand);
      if (source) {
        for (const harness of targets) {
          this.sink(
            new PluginInstalledEvent(
              source.reportableId(),
              harness,
              marketplace,
              source.kind,
              targetsExplicit,
              durationMs,
            ),
          );
        }
      }
      if (result.isFailed()) this.failed(source, marketplace, result.report.stage, 'user');
      return result;
    } catch (err) {
      // A throw from here is a bug, not a problem the user can fix. Both facts
      // it reports come off the action, because there is no report to read.
      this.failed(
        action.source,
        MarketplaceLabel.forSource(action.source, req.brand),
        action.stage,
        'unexpected',
      );
      throw err;
    }
  }

  private failed(
    source: PluginSource | null,
    marketplace: MarketplaceLabel,
    stage: InstallStage | null,
    kind: ErrorKind,
  ): void {
    const sourceKind: SourceKind | null = source?.kind ?? null;
    this.sink(
      new PluginInstallFailedEvent(
        source?.reportableId() ?? null,
        marketplace,
        sourceKind,
        stage,
        kind,
      ),
    );
  }
}
