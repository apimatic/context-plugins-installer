import type { ActionResult } from '../actions/action-result.js';
import { UninstallAction, type UninstallRequest } from '../actions/uninstall.js';
import { UninstallPrompts } from '../prompts/uninstall.js';
import { marketplaceLabel } from '../types/brand.js';
import { PluginId } from '../types/ids/plugin-id.js';
import type { UninstallResult } from '../types/reports.js';
import { EVENTS, type TrackFn } from '../types/telemetry.js';

/**
 * `uninstall` reports what it removed even when another editor failed - a
 * partial uninstall is still work done, and the events say so before the
 * failure does. Nothing here decides anything: the action already has.
 */
export class UninstallCommand {
  constructor(private readonly track: TrackFn) {}

  async run(req: UninstallRequest): Promise<ActionResult<UninstallResult>> {
    const prompts = new UninstallPrompts(req.pathOpts?.home);
    const marketplace = marketplaceLabel(req.brand);
    try {
      const result = await new UninstallAction(prompts, req.deps, req.pathOpts).execute(req);
      // Before the failure below, so a partial uninstall still reports what it did.
      for (const harness of result.report.targets) {
        this.track(EVENTS.uninstalled, { plugin: result.report.plugin, harness, marketplace });
      }
      if (result.isFailed()) this.fireFailure(req.plugin, marketplace, 'user');
      return result;
    } catch (err) {
      // A throw from here is a bug, not a problem the user can fix.
      this.fireFailure(req.plugin, marketplace, 'unexpected');
      throw err;
    }
  }

  private fireFailure(plugin: string, marketplace: string, kind: string): void {
    this.track(EVENTS.uninstallFailed, {
      plugin: PluginId.create(plugin)?.toString() ?? null,
      marketplace,
      stage: null,
      error_kind: kind,
    });
  }
}
