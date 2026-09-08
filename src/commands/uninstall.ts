import type { ActionResult } from '../actions/action-result.js';
import { UninstallAction, type UninstallRequest } from '../actions/uninstall.js';
import { UninstallPrompts } from '../prompts/uninstall.js';
import { MarketplaceLabel } from '../types/brand.js';
import type { EventSink } from '../types/events/domain-event.js';
import { PluginUninstallFailedEvent } from '../types/events/plugin-uninstall-failed.js';
import { PluginUninstalledEvent } from '../types/events/plugin-uninstalled.js';
import type { PluginId } from '../types/ids/plugin-id.js';
import type { UninstallResult } from '../types/reports.js';
import type { ErrorKind } from '../types/telemetry.js';

/**
 * `uninstall` reports what it removed even when another editor failed - a
 * partial uninstall is still work done, and the events say so before the
 * failure does. Nothing here decides anything: the action already has.
 */
export class UninstallCommand {
  constructor(private readonly sink: EventSink) {}

  async run(req: UninstallRequest): Promise<ActionResult<UninstallResult>> {
    const prompts = new UninstallPrompts(req.pathOpts?.home);
    const marketplace = MarketplaceLabel.of(req.brand);
    const action = new UninstallAction(prompts, req.deps, req.pathOpts);
    try {
      const result = await action.execute(req);
      const { plugin, targets } = result.report;
      // Before the failure below, so a partial uninstall still reports what it did.
      if (plugin) {
        for (const harness of targets) {
          this.sink(new PluginUninstalledEvent(plugin, harness, marketplace));
        }
      }
      if (result.isFailed()) this.failed(plugin, marketplace, 'user');
      return result;
    } catch (err) {
      // A throw from here is a bug, not a problem the user can fix.
      this.failed(action.plugin, marketplace, 'unexpected');
      throw err;
    }
  }

  private failed(plugin: PluginId | null, marketplace: MarketplaceLabel, kind: ErrorKind): void {
    this.sink(new PluginUninstallFailedEvent(plugin, marketplace, kind));
  }
}
