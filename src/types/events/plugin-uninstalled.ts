import type { MarketplaceLabel } from '../brand.js';
import type { HarnessName } from '../harness.js';
import type { PluginId } from '../ids/plugin-id.js';
import type { SourceKind } from '../plugin-source.js';
import type { TelemetryValue } from '../telemetry.js';
import { DomainEvent } from './domain-event.js';

/**
 * One editor a plugin was actually removed from. A record this run corrected
 * without removing anything is not one of these: nothing left that machine.
 *
 * `plugin` is nullable because removing a plugin may say no more about it than
 * installing one did: a plugin that came from a directory is named by a folder
 * the user chose, and that name stays on their machine either way.
 */
export class PluginUninstalledEvent extends DomainEvent {
  readonly name = 'Context Plugin Uninstalled';

  constructor(
    private readonly plugin: PluginId | null,
    private readonly harness: HarnessName,
    private readonly marketplace: MarketplaceLabel,
    /**
     * Where the plugin came from, as a kind and never as a path or a
     * repository: `marketplace`, or `local` for a directory on this machine.
     */
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
