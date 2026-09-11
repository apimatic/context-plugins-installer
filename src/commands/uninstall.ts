import type { ActionResult } from '../actions/action-result.js';
import { UninstallAction, type UninstallRequest } from '../actions/uninstall.js';
import { UninstallPrompts } from '../prompts/uninstall.js';
import { MarketplaceLabel, type Brand } from '../types/brand.js';
import type { EventSink } from '../types/events/domain-event.js';
import type { RegistryClient } from '../types/ports.js';
import { PluginUninstallFailedEvent } from '../types/events/plugin-uninstall-failed.js';
import { PluginUninstalledEvent } from '../types/events/plugin-uninstalled.js';
import type { PluginSource } from '../types/plugin-source.js';
import type { UninstallResult } from '../types/reports.js';
import type { ErrorKind } from '../types/telemetry.js';

/**
 * `uninstall` reports what it removed even when another editor failed - a
 * partial uninstall is still work done, and the events say so before the
 * failure does. Nothing here decides anything: the action already has.
 */
export class UninstallCommand {
  constructor(
    private readonly sink: EventSink,
    private readonly registry: RegistryClient,
  ) {}

  async run(req: UninstallRequest): Promise<ActionResult<UninstallResult>> {
    const prompts = new UninstallPrompts(req.pathOpts?.home);
    const action = new UninstallAction(prompts, this.registry, req.pathOpts);
    try {
      const result = await action.execute(req);
      const { source, targets } = result.report;
      // Before the failure below, so a partial uninstall still reports what it did.
      if (source) {
        for (const harness of targets) {
          this.sink(
            new PluginUninstalledEvent(
              source.reportableId(),
              harness,
              MarketplaceLabel.forSource(source, req.brand),
              source.kind,
            ),
          );
        }
      }
      if (result.isFailed()) this.failed(source, req.brand, 'user');
      return result;
    } catch (err) {
      // A throw from here is a bug, not a problem the user can fix.
      this.failed(action.source, req.brand, 'unexpected');
      throw err;
    }
  }

  /**
   * Nothing here decides what may be said about the plugin: the id comes off
   * the source through `reportableId`, which withholds a local plugin's, and
   * the label off `forSource`, which refuses to name the built-in marketplace
   * for a plugin that never came from it.
   */
  private failed(source: PluginSource | null, brand: Brand, kind: ErrorKind): void {
    this.sink(
      new PluginUninstallFailedEvent(
        source?.reportableId() ?? null,
        MarketplaceLabel.forSource(source, brand),
        source?.kind ?? null,
        kind,
      ),
    );
  }
}
