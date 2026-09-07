import { resolvePlugin } from '../application/plugin-resolution.js';
import { resolveTargets } from '../application/target-selection.js';
import { decideUninstall, uninstallLines } from '../application/uninstall-decision.js';
import { harnesses } from '../harnesses/index.js';
import { readRegistry } from '../infrastructure/github-registry-client.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { UninstallPrompts } from '../prompts/uninstall.js';
import { BIN, type Brand } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import {
  titlesOf,
  type HarnessName,
  type HarnessOpts,
  type UninstallOutcome,
} from '../types/harness.js';
import { PluginId } from '../types/ids/plugin-id.js';
import type { Deps } from '../types/ports.js';
import type { UninstallResult } from '../types/reports.js';
import { errorMessage, nonEmptyString } from '../util.js';
import { ActionResult } from './action-result.js';

export interface UninstallRequest {
  brand: Brand;
  plugin: string;
  targets?: readonly string[] | null;
  /** Clear the record even for editors that could not confirm the removal. */
  force?: boolean;
  deps?: Deps;
  pathOpts?: HarnessOpts;
}

/**
 * Take a plugin out of every editor asked for, and correct the record to match
 * what actually happened. Two invariants live here and nowhere else:
 *
 * - Every editor is visited even if one throws, so a partial failure neither
 *   hides the others nor loses the removals already done.
 * - The record and every line of the summary come from one `decideUninstall`
 *   over the outcomes, so the two cannot disagree about what happened.
 */
export class UninstallAction {
  constructor(
    private readonly prompts: UninstallPrompts,
    private readonly deps: Deps = {},
    private readonly pathOpts?: HarnessOpts,
  ) {}

  /**
   * The name Claude Code knows the marketplace by. A row's own recorded name is
   * what keeps this offline; a lookup is only needed when there is none, and
   * with a row to correct a failed lookup must not block cleaning it up.
   */
  private async marketplaceFor(
    brand: Brand,
    plugin: string,
    recorded: Record<string, unknown> | null,
    want: readonly HarnessName[],
  ): Promise<{ marketplace: string | null } | { failure: Failure }> {
    const known =
      brand.id || (recorded && nonEmptyString(recorded.marketplace) ? recorded.marketplace : null);
    if (known || !want.includes('claude')) return { marketplace: known };

    const read = await readRegistry({
      repo: brand.repo,
      ref: brand.ref,
      deps: this.deps,
      notify: this.prompts.marketplaceListener,
    });
    const resolved = read.ok
      ? resolvePlugin(read.value, { plugin, repo: brand.repo, ref: brand.ref })
      : read;
    if (resolved.ok) return { marketplace: resolved.value.marketplace };
    // With no record there is nothing to correct, so the lookup error and its
    // suggestion are the useful answer.
    if (!recorded) return { failure: resolved.error };
    this.prompts.marketplaceUnknown(plugin, resolved.error);
    return { marketplace: null };
  }

  readonly execute = async (req: UninstallRequest): Promise<ActionResult<UninstallResult>> => {
    const { brand, force = false } = req;
    const nothing: UninstallResult = { plugin: req.plugin, targets: [], failed: [] };

    const id = PluginId.parse(req.plugin);
    if (!id.ok) return ActionResult.failed(nothing, id.error);
    const plugin = id.value.toString();

    const records = openManifest(paths.manifestPath(this.pathOpts));
    const key = { plugin, repo: brand.repo };
    // The raw row: uninstall must also clear rows the sanitized view hides, and
    // their recorded marketplace is what keeps the Claude path offline.
    const recorded = records.findRaw(key);

    const targets = resolveTargets(req.targets);
    if (!targets.ok) return ActionResult.failed(nothing, targets.error);
    const want = targets.value;

    const found = await this.marketplaceFor(brand, plugin, recorded, want);
    if ('failure' in found) return ActionResult.failed(nothing, found.failure);

    this.prompts.intro(plugin, brand, want);

    // One entry per editor visited. `decideUninstall` derives everything the
    // record and the summary say from exactly this, so the two cannot disagree.
    const outcomes = new Map<HarnessName, UninstallOutcome>();
    for (const name of want) {
      const harness = harnesses.byName(name);
      this.prompts.beginHarness(harness.title);
      try {
        outcomes.set(
          name,
          await harness.uninstall(
            {
              plugin,
              marketplace: found.marketplace,
              repo: brand.repo,
              listener: this.prompts.harnessListener,
            },
            this.pathOpts,
          ),
        );
      } catch (err) {
        // One editor's I/O failure is not the others' business.
        this.prompts.harnessThrew(harness.title, errorMessage(err));
        outcomes.set(name, 'failed');
      }
    }

    const decision = decideUninstall({ recorded: recorded ?? null, outcomes, want, force });
    // Not in a `finally`: a write failure on the success path must not pass
    // silently as one more thing that went wrong.
    records.applyUninstall(key, decision);

    this.prompts.summary(uninstallLines(decision, { plugin, bin: BIN }));

    const report: UninstallResult = {
      plugin,
      targets: decision.removed,
      failed: decision.failed,
    };
    // Asked and went wrong is not a clean uninstall, however much else worked -
    // and the summary above has already said what did.
    if (!report.failed.length) return ActionResult.success(report);
    return ActionResult.failed(
      report,
      new Failure(
        `Could not uninstall '${plugin}' from ${titlesOf(report.failed)}.`,
        'Close the editor if it is running, then try again - or --verbose for detail.',
      ),
    );
  };
}
