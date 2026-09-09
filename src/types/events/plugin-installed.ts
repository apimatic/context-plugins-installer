import type { MarketplaceLabel } from '../brand.js';
import type { HarnessName } from '../harness.js';
import type { PluginId } from '../ids/plugin-id.js';
import type { SourceKind } from '../plugin-source.js';
import type { TelemetryValue } from '../telemetry.js';
import { DomainEvent } from './domain-event.js';

/**
 * One editor a plugin went into. One event per editor rather than one per run,
 * because "how many machines have this plugin in Cursor" is the question this
 * answers, and a list property could not be counted.
 *
 * `plugin` is nullable for the same reason it is on the failure event, and one
 * more: a plugin installed from a directory is named by a folder the user
 * chose, which makes it their name rather than a public one. The source decides
 * that, not this class and not the command - see `reportableId`.
 */
export class PluginInstalledEvent extends DomainEvent {
  readonly name = 'Context Plugin Installed';

  constructor(
    private readonly plugin: PluginId | null,
    private readonly harness: HarnessName,
    private readonly marketplace: MarketplaceLabel,
    /**
     * Where the plugin came from, as a kind and never as a path or a repository:
     * `marketplace`, or `local` for a directory on this machine.
     */
    private readonly sourceKind: SourceKind,
    private readonly targetsExplicit: boolean,
    private readonly durationMs: number,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return {
      plugin: this.plugin?.toString() ?? null,
      harness: this.harness,
      marketplace: this.marketplace.toString(),
      source_kind: this.sourceKind,
      targets_explicit: this.targetsExplicit,
      duration_ms: this.durationMs,
    };
  }
}
