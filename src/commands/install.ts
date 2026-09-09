import type { ActionResult } from '../actions/action-result.js';
import { InstallAction, type InstallRequest } from '../actions/install.js';
import { InstallPrompts } from '../prompts/install.js';
import { MarketplaceLabel, type Brand } from '../types/brand.js';
import type { EventSink } from '../types/events/domain-event.js';
import { PluginInstallFailedEvent } from '../types/events/plugin-install-failed.js';
import { PluginInstalledEvent } from '../types/events/plugin-installed.js';
import type { PluginSource, SourceKind } from '../types/plugin-source.js';
import type { InstallReport, InstallStage } from '../types/reports.js';
import type { Session } from '../types/session.js';
import type { ErrorKind } from '../types/telemetry.js';

/**
 * What telemetry may call the marketplace a run installed from. Only a
 * marketplace source has one to name: a plugin that came from a directory did
 * not come from the configured repository, and reporting the built-in
 * marketplace's name for it would be wrong rather than merely vague.
 *
 * A source this program could not parse leaves the run about the configured
 * marketplace as far as it got, which is what `of` answers.
 */
const labelFor = (source: PluginSource | null, brand: Brand): MarketplaceLabel =>
  source && source.kind !== 'marketplace' ? MarketplaceLabel.custom() : MarketplaceLabel.of(brand);

/**
 * One event per editor the plugin went into, then one for a failure - which
 * carries the stage the report was left at rather than any message, because a
 * message could name a path or a plugin the user typed.
 *
 * Nothing here decides what may be reported about the plugin itself. The id
 * comes off the source through `reportableId`, which withholds a local
 * plugin's: a name taken from a folder the user chose is theirs, not a public
 * plugin name, and a command that had to remember that would eventually forget.
 */
export class InstallCommand {
  constructor(private readonly sink: EventSink) {}

  async run(req: InstallRequest, session: Session): Promise<ActionResult<InstallReport>> {
    const prompts = new InstallPrompts(req.pathOpts?.home, req.ask);
    const action = new InstallAction(prompts, session, req.pathOpts);
    try {
      const result = await action.execute(req);
      const { source, targets, targetsExplicit, durationMs } = result.report;
      const marketplace = labelFor(source, req.brand);
      // An editor can only be on the list once a source parsed, so this reads
      // as a guard and is really the type saying that out loud.
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
      this.failed(action.source, labelFor(action.source, req.brand), action.stage, 'unexpected');
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
