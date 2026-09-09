import type { MarketplaceLabel } from '../brand.js';
import type { PluginId } from '../ids/plugin-id.js';
import type { InstallStage } from '../reports.js';
import type { ErrorKind, TelemetryValue } from '../telemetry.js';
import { DomainEvent } from './domain-event.js';

/**
 * An install that did not finish. What went wrong travels as the stage it
 * happened at and the kind of problem it was - never as a message, which could
 * quote a path, a repository the user named, or an editor's own error text.
 *
 * `plugin` is null when the id never validated: an id this program rejected is
 * a string the user typed, and it stays on their machine.
 */
export class PluginInstallFailedEvent extends DomainEvent {
  readonly name = 'Context Plugin Install Failed';

  constructor(
    private readonly plugin: PluginId | null,
    private readonly marketplace: MarketplaceLabel,
    private readonly stage: InstallStage | null,
    private readonly errorKind: ErrorKind,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return {
      plugin: this.plugin?.toString() ?? null,
      marketplace: this.marketplace.toString(),
      stage: this.stage,
      error_kind: this.errorKind,
    };
  }
}
