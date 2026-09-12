import type { MarketplaceLabel } from '../brand.js';
import type { HarnessName } from '../harness.js';
import type { PluginId } from '../ids/plugin-id.js';
import type { SourceKind } from '../plugin-source.js';
import type { TelemetryValue } from '../telemetry.js';
import { DomainEvent } from './domain-event.js';

/**
 * One editor a plugin was actually removed from. A record this run corrected
 * without removing anything is not one of these: nothing left that machine.
 */
export class PluginUninstalledEvent extends DomainEvent {
  readonly name = 'Context Plugin Uninstalled';

  constructor(
    private readonly plugin: PluginId | null,
    private readonly harness: HarnessName,
    private readonly marketplace: MarketplaceLabel,
    private readonly sourceKind: SourceKind,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return {
      plugin: this.plugin?.toString() ?? null,
      harness: this.harness,
      marketplace: this.marketplace.toString(),
      source_kind: this.sourceKind,
    };
  }
}
