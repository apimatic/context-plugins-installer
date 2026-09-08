import type { MarketplaceLabel } from '../brand.js';
import type { HarnessName } from '../harness.js';
import type { PluginId } from '../ids/plugin-id.js';
import type { TelemetryValue } from '../telemetry.js';
import { DomainEvent } from './domain-event.js';

/**
 * One editor a plugin went into. One event per editor rather than one per run,
 * because "how many machines have this plugin in Cursor" is the question this
 * answers, and a list property could not be counted.
 */
export class PluginInstalledEvent extends DomainEvent {
  readonly name = 'Context Plugin Installed';

  constructor(
    private readonly plugin: PluginId,
    private readonly harness: HarnessName,
    private readonly marketplace: MarketplaceLabel,
    private readonly targetsExplicit: boolean,
    private readonly durationMs: number,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return {
      plugin: this.plugin.toString(),
      harness: this.harness,
      marketplace: this.marketplace.toString(),
      targets_explicit: this.targetsExplicit,
      duration_ms: this.durationMs,
    };
  }
}
