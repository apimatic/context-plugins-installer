import { resolvePlugin } from '../application/plugin-resolution.js';
import { chooseTargets, resolveTargets } from '../application/target-selection.js';
import { harnesses } from '../harnesses/index.js';
import { isInteractive } from '../infrastructure/environment.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { InstallPrompts } from '../prompts/install.js';
import { InstallPrompts as Prompts, type Ask } from '../prompts/install.js';
import type { Brand } from '../types/brand.js';
import type { DirectoryPath } from '../types/file/paths.js';
import { Failure } from '../types/failure.js';
import type { HarnessContext, HarnessName, HarnessOpts } from '../types/harness.js';
import { PluginId } from '../types/ids/plugin-id.js';
import type { InstallReport, InstallStage } from '../types/reports.js';
import type { Session } from '../types/session.js';
import { ActionResult } from './action-result.js';

export interface InstallRequest {
  brand: Brand;
  plugin: string;
  ref?: string;
  /** Harness names, `all`, or nothing for "ask". */
  targets?: readonly string[] | null;
  force?: boolean;
  assumeYes?: boolean;
  /** Whoever answers "install into X?"; a real prompter when nobody does. */
  ask?: Ask;
  /** HarnessOpts, not PathOpts: this is forwarded to the harnesses, runner and all. */
  pathOpts?: HarnessOpts;
}

/**
 * Put one plugin into every editor the run settles on. The report is built as
 * the run advances rather than at the end, because its `stage` is what a
 * failure event reports - and a failure can happen at any of the four.
 */
export class InstallAction {
  /**
   * How far this run got, and which plugin it was about. An instance serves one
   * run, and the command's catch reads both: an unexpected throw still has to
   * report where it happened and what it was doing, which is what the old
   * mutable `progress` object was threaded through for.
   */
  private at: InstallStage = 'resolve';

  private id: PluginId | null = null;

  get stage(): InstallStage {
    return this.at;
  }

  get plugin(): PluginId | null {
    return this.id;
  }

  constructor(
    private readonly prompts: InstallPrompts,
    private readonly session: Session,
    private readonly pathOpts?: HarnessOpts,
  ) {}

  readonly execute = async (req: InstallRequest): Promise<ActionResult<InstallReport>> => {
    const { brand, force = false, assumeYes = false } = req;
    const startedAt = Date.now();
    const ref = req.ref || brand.ref;
    const explicit = Array.isArray(req.targets) && req.targets.length > 0;
    // Validated before the report exists rather than written into it after, so
    // there is no arm on which the report holds the string the user typed.
    const parsed = PluginId.parse(req.plugin);
    if (parsed.ok) this.id = parsed.value;
    const report: Omit<InstallReport, 'stage' | 'durationMs'> = {
      plugin: this.id,
      targets: [],
      untouched: [],
      marketplace: '',
      ref,
      targetsExplicit: explicit,
    };
    const done = (): InstallReport => ({
      ...report,
      stage: this.at,
      durationMs: Date.now() - startedAt,
    });
    const failed = (failure: Failure): ActionResult<InstallReport> =>
      ActionResult.failed(done(), failure);

    if (!parsed.ok) return failed(parsed.error);
    const plugin = parsed.value.toString();

    const records = openManifest(paths.manifestPath(this.pathOpts));

    const catalog = await this.session.catalog({ repo: brand.repo, ref });
    if (!catalog.ok) return failed(catalog.error);
    const found = resolvePlugin(catalog.value, {
      plugin,
      repo: brand.repo,
      ref,
      marketplace: brand.id,
      label: brand.label,
    });
    if (!found.ok) return failed(found.error);
    const resolved = found.value;
    const { origin } = resolved;
    const marketplace = origin.name;
    report.marketplace = marketplace;

    this.at = 'harnesses';
    const targets = resolveTargets(req.targets);
    if (!targets.ok) return failed(targets.error);
    const requested = targets.value;

    const conflict = force ? null : records.conflictFor({ plugin, repo: brand.repo });
    if (conflict) return failed(conflict);
    const recorded = records.find({ plugin, repo: brand.repo });

    this.prompts.intro(plugin, brand, ref, marketplace, resolved.description);

    const available = harnesses.detected(requested, this.pathOpts);
    const missing = requested.filter((name) => !available.includes(name));
    for (const name of missing) {
      this.prompts.notInstalled(harnesses.byName(name), this.pathOpts);
    }
    if (!available.length) {
      const { message, hint } = Prompts.noEditor(explicit, missing);
      return failed(new Failure(message, hint));
    }
    if (missing.length) this.prompts.continuingWith(available);

    const want = await this.choose(available, explicit, assumeYes);
    // Ctrl-C at the prompt. The line was said where it happened, so there is
    // nothing to add: the run stops here and the router answers 130.
    if (want === 'cancelled') return ActionResult.cancelled(done());
    if (!want.length) {
      this.prompts.nothingChosen();
      return ActionResult.success(done());
    }
    this.prompts.installingInto(want);

    // Editors an earlier run installed into that this run skips. Their copies
    // are still on disk, so they stay on the record or `update` would never
    // refresh them.
    report.untouched = (recorded?.targets ?? []).filter((n) => !want.includes(n));

    let srcDir: DirectoryPath | null = null;
    if (want.some((name) => harnesses.byName(name).needsSource)) {
      this.at = 'fetch';
      this.prompts.fetching();
      const source = await this.session.source({
        repo: brand.repo,
        ref,
        sourcePath: resolved.sourcePath,
      });
      if (!source.ok) return failed(source.error);
      srcDir = source.value;
      this.prompts.sourceReady();
    }

    this.at = 'install';
    // Every field is settled before the loop, so one context serves every editor.
    const ctx: HarnessContext = {
      plugin,
      origin,
      srcDir,
      session: this.session,
      listener: this.prompts.harnessListener,
    };
    const installed: HarnessName[] = [];
    for (const name of want) {
      const harness = harnesses.byName(name);
      this.prompts.beginHarness(harness.title);
      if (harness.needsSource && !ctx.srcDir) {
        this.prompts.noSource(harness.title);
        continue;
      }
      const outcome = await harness.install(ctx, this.pathOpts);
      // An editor that looked and could not is the user's to fix, so the run
      // stops here and says so - never tested for truth, because both arms of
      // a `Result` and both outcomes inside one are objects and strings.
      if (!outcome.ok) return failed(outcome.error);
      if (outcome.value === 'installed') installed.push(name);
    }
    report.targets = installed;

    if (installed.length) {
      records.recordInstall({
        plugin,
        repo: brand.repo,
        marketplace,
        ref,
        installed,
        untouched: report.untouched,
      });
    }

    this.prompts.summary(installed, report.untouched);
    return ActionResult.success(done());
  };

  /**
   * Which editors to use. The decision is `chooseTargets` in application - the
   * three answers are already-told, ask, and nobody-to-ask - and this is the
   * asking, plus the one line the third case is worth. An injected confirm
   * counts as someone to answer.
   */
  private async choose(
    available: HarnessName[],
    explicit: boolean,
    assumeYes: boolean,
  ): Promise<HarnessName[] | 'cancelled'> {
    const choice = chooseTargets({
      detected: available.length,
      explicit,
      assumeYes,
      // The prompts own the answerer; this only adds what they cannot see.
      canAsk: this.prompts.hasAnswerer() || isInteractive(),
    });
    if (choice === 'take-all') return available;
    if (choice === 'cannot-ask') {
      this.prompts.nobodyToAsk();
      return available;
    }
    return this.prompts.askHarnesses(available);
  }
}
