import type { MarketplaceLabel } from '../brand.js';
import type { PluginId } from '../ids/plugin-id.js';
import type { ErrorKind, TelemetryValue } from '../telemetry.js';
import { DomainEvent } from './domain-event.js';

/**
 * An uninstall that could not finish. `stage` is always null and is sent
 * anyway: the two failure events are one funnel in the Mixpanel project, and a
 * property that appears on one arm and is missing from the other cannot be
 * grouped by.
 */
export class PluginUninstallFailedEvent extends DomainEvent {
  readonly name = 'Context Plugin Uninstall Failed';

  constructor(
    private readonly plugin: PluginId | null,
    private readonly marketplace: MarketplaceLabel,
    private readonly errorKind: ErrorKind,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return {
      plugin: this.plugin?.toString() ?? null,
      marketplace: this.marketplace.toString(),
      stage: null,
      error_kind: this.errorKind,
    };
  }
}
