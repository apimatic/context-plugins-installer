import { resolvePlugin } from '../application/plugin-resolution.js';
import { chooseTargets, resolveTargets } from '../application/target-selection.js';
import { harnesses } from '../harnesses/index.js';
import { isInteractive } from '../infrastructure/environment.js';
import { localMarketplace, stageLocalPlugin } from '../infrastructure/local-marketplace.js';
import { readLocalPlugin } from '../infrastructure/local-plugin.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { InstallPrompts } from '../prompts/install.js';
import { InstallPrompts as Prompts, type Ask } from '../prompts/install.js';
import type { Brand } from '../types/brand.js';
import type { DirectoryPath } from '../types/file/paths.js';
import { Failure } from '../types/failure.js';
import type { HarnessContext, HarnessName, HarnessOpts } from '../types/harness.js';
import type { PluginId } from '../types/ids/plugin-id.js';
import type { NamedMarketplace } from '../types/marketplace-origin.js';
import { parseSource, type PluginSource } from '../types/plugin-source.js';
import type { InstallReport, InstallStage } from '../types/reports.js';
import { err, ok, type Result } from '../types/result.js';
import type { Session } from '../types/session.js';
import { ActionResult } from './action-result.js';

export interface InstallRequest {
  brand: Brand;
  plugin: string | PluginSource;
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

type PluginFiles =
  | { kind: 'on-disk'; dir: DirectoryPath }
  | { kind: 'remote'; repo: string; ref: string; sourcePath: string | null };

interface Resolution {
  id: PluginId;
  origin: NamedMarketplace;
  description: string;
  files: PluginFiles;
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

  private from: PluginSource | null = null;

  get stage(): InstallStage {
    return this.at;
  }

  get plugin(): PluginId | null {
    return this.id;
  }

  get source(): PluginSource | null {
    return this.from;
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
    const parsed =
      typeof req.plugin === 'string'
        ? parseSource(req.plugin, {
            repo: brand.repo,
            ref,
            ...paths.pathContext(this.pathOpts),
          })
        : ok(req.plugin);
    if (parsed.ok) {
      this.from = parsed.value;
      // A local or github source only learns its id at the resolve stage below.
      if (parsed.value.kind === 'marketplace') this.id = parsed.value.plugin;
    }
    const report: Omit<InstallReport, 'stage' | 'durationMs' | 'plugin' | 'source'> = {
      targets: [],
      untouched: [],
      marketplace: '',
      ref,
      targetsExplicit: explicit,
    };
    const done = (): InstallReport => ({
      ...report,
      plugin: this.id,
      source: this.from,
      stage: this.at,
      durationMs: Date.now() - startedAt,
    });
    const failed = (failure: Failure): ActionResult<InstallReport> =>
      ActionResult.failed(done(), failure);

    if (!parsed.ok) return failed(parsed.error);
    const source = parsed.value;
    report.ref = source.kind === 'local' ? null : source.ref;

    const records = openManifest(paths.manifestPath(this.pathOpts));

    const settled = await this.resolve(source, brand);
    if (!settled.ok) return failed(settled.error);
    const resolved = settled.value;
    const { origin } = resolved;
    const plugin = resolved.id.toString();
    const marketplace = origin.name;
    report.marketplace = marketplace;

    this.at = 'harnesses';
    const targets = resolveTargets(req.targets);
    if (!targets.ok) return failed(targets.error);
    const requested = targets.value;

    const key = { plugin, repo: source.key() };
    const conflict = force ? null : records.conflictFor(key);
    if (conflict) return failed(conflict);
    const recorded = records.find(key);

    this.prompts.intro(plugin, brand, report.ref, marketplace, resolved.description, source);
    if (req.ref && source.kind === 'github' && source.ref !== ref) {
      this.prompts.refIgnored(req.ref, source.ref);
    }

    // Must stay ahead of any fetch or copy: a plugin from an arbitrary
    // directory or repository can carry hooks and MCP servers that run commands.
    if (source.kind !== 'marketplace') {
      const trusted = await this.prompts.confirmSource(source, assumeYes || !this.canAsk());
      if (trusted === 'cancelled') return ActionResult.cancelled(done());
      if (!trusted) {
        this.prompts.nothingTrusted();
        return ActionResult.success(done());
      }
    }

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

    const { files } = resolved;
    let srcDir: DirectoryPath | null = files.kind === 'on-disk' ? files.dir : null;
    // Claude Code installs only from a marketplace, so a plugin from anywhere
    // else is staged into the generated one - which needs the files fetched
    // even when no editor in this run copies them.
    const mustStage = origin.kind === 'directory' && want.includes('claude');
    if (
      files.kind === 'remote' &&
      (mustStage || want.some((name) => harnesses.byName(name).needsSource))
    ) {
      this.at = 'fetch';
      this.prompts.fetching();
      const fetched = await this.session.source({
        repo: files.repo,
        ref: files.ref,
        sourcePath: files.sourcePath,
      });
      if (!fetched.ok) return failed(fetched.error);
      srcDir = fetched.value;
      this.prompts.sourceReady();
    }

    this.at = 'install';
    if (mustStage && srcDir) {
      const staged = stageLocalPlugin(
        { plugin, srcDir, description: resolved.description },
        this.pathOpts,
      );
      if (!staged.ok) return failed(staged.error);
    }

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
        repo: source.key(),
        marketplace,
        ref: report.ref,
        installed,
        untouched: report.untouched,
      });
    }

    this.prompts.summary(installed, report.untouched);
    return ActionResult.success(done());
  };

  private async resolve(source: PluginSource, brand: Brand): Promise<Result<Resolution, Failure>> {
    if (source.kind === 'local') {
      const read = readLocalPlugin(source.dir, this.pathOpts);
      if (!read.ok) return err(read.error);
      this.id = read.value.id;
      return ok({
        id: read.value.id,
        origin: localMarketplace(this.pathOpts),
        description: read.value.description,
        files: { kind: 'on-disk', dir: read.value.dir },
      });
    }

    if (source.kind === 'github') {
      const manifest = await this.session.manifest({
        repo: source.repo,
        ref: source.ref,
        path: source.path,
      });
      if (!manifest.ok) return err(manifest.error);
      this.id = manifest.value.id;
      return ok({
        id: manifest.value.id,
        // No registry lists this plugin, so Claude Code addresses it through
        // the same generated marketplace a directory install uses.
        origin: localMarketplace(this.pathOpts),
        description: manifest.value.description,
        files: {
          kind: 'remote',
          repo: source.repo,
          ref: source.ref,
          sourcePath: source.path,
        },
      });
    }

    const catalog = await this.session.catalog({ repo: source.repo, ref: source.ref });
    if (!catalog.ok) return err(catalog.error);
    const found = resolvePlugin(catalog.value, {
      plugin: source.plugin.toString(),
      repo: source.repo,
      ref: source.ref,
      marketplace: brand.id,
      label: brand.label,
    });
    if (!found.ok) return err(found.error);
    return ok({
      id: source.plugin,
      origin: found.value.origin,
      description: found.value.description,
      files: {
        kind: 'remote',
        repo: source.repo,
        ref: source.ref,
        sourcePath: found.value.sourcePath,
      },
    });
  }

  private canAsk(): boolean {
    return this.prompts.hasAnswerer() || isInteractive();
  }

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
      canAsk: this.canAsk(),
    });
    if (choice === 'take-all') return available;
    if (choice === 'cannot-ask') {
      this.prompts.nobodyToAsk();
      return available;
    }
    return this.prompts.askHarnesses(available);
  }
}
