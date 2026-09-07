import {
  decideUninstall,
  nothingChanged,
  uninstallLines,
} from './application/uninstall-decision.js';
import { resolvePlugin } from './application/plugin-resolution.js';
import { chooseTargets, resolveTargets } from './application/target-selection.js';
import { loadCatalog } from './catalog.js';
import { byName } from './harness/index.js';
import { log } from './log.js';
import * as paths from './infrastructure/paths.js';
import { createPrompter } from './prompt.js';
import { announceMarketplace } from './prompts/marketplace.js';
import { isInteractive } from './infrastructure/environment.js';
import { openManifest } from './infrastructure/manifest-store.js';
import { createSession } from './infrastructure/session.js';
import { EVENTS, marketplaceLabel } from './infrastructure/telemetry-service.js';
import { BIN, type Brand } from './types/brand.js';
import {
  NAMES,
  everyEditor,
  titlesOf,
  type HarnessContext,
  type HarnessName,
  type HarnessOpts,
  type UninstallOutcome,
} from './types/harness.js';
import { PluginId } from './types/ids/plugin-id.js';
import { RepoSlug } from './types/ids/repo-slug.js';
import type { Deps } from './types/ports.js';
import type { InstallResult, ListResult, UninstallResult, UpdateResult } from './types/reports.js';
import type { Session } from './types/session.js';
import type { TrackFn } from './types/telemetry.js';
import { assertPlugin, nonEmptyString, orThrow, UserError, errorMessage } from './util.js';

const noTrack: TrackFn = () => {};

// A sink listens; it never takes part. Whatever it throws stays out of the run,
// which has already written its files by the time the success events fire.
function sinkOf(deps: Deps | undefined): TrackFn {
  const track = deps?.track;
  if (!track) return noTrack;
  return (name, properties) => {
    try {
      track(name, properties);
    } catch (err) {
      log.debug(`telemetry: ${errorMessage(err)}`);
    }
  };
}

/** How far a run got before it threw; coarse on purpose, so no message travels. */
type Stage = 'resolve' | 'harnesses' | 'fetch' | 'install';

// An error message can quote a path or a marketplace name, so only its class
// goes out - and the plugin id only once it has passed validation.
function trackFailure(
  track: TrackFn,
  event: string,
  { plugin, brand, stage, err }: { plugin: string; brand: Brand; stage?: Stage; err: unknown },
): void {
  track(event, {
    plugin: PluginId.create(plugin)?.toString() ?? null,
    marketplace: marketplaceLabel(brand),
    stage: stage ?? null,
    error_kind: err instanceof UserError ? 'user' : 'unexpected',
  });
}

type Ask = (question: string, defaultYes: boolean) => boolean | Promise<boolean>;

async function askEach(names: readonly HarnessName[], ask: Ask): Promise<HarnessName[]> {
  const chosen: HarnessName[] = [];
  for (const name of names) {
    if (await ask(`Install into ${byName(name).title}?`, true)) chosen.push(name);
  }
  return chosen;
}

export interface ChooseOptions {
  explicit?: boolean;
  assumeYes?: boolean;
  confirm?: Ask;
  /** Called when the interactive flow is about to be drawn. */
  onPrompted?: () => void;
}

// The decision - already answered, ask, or nobody to ask - is
// application/target-selection; this is the asking, and the one line the third
// case is worth. An injected confirm counts as someone to answer.
export async function chooseHarnesses(
  available: HarnessName[],
  { explicit = false, assumeYes = false, confirm, onPrompted }: ChooseOptions = {},
): Promise<HarnessName[]> {
  const choice = chooseTargets({
    detected: available.length,
    explicit,
    assumeYes,
    canAsk: Boolean(confirm) || isInteractive(),
  });
  if (choice === 'take-all') return available;
  if (choice === 'cannot-ask') {
    log.info('Non-interactive shell - using every detected harness (--targets to choose).');
    return available;
  }

  if (confirm) return askEach(available, confirm);

  if (onPrompted) onPrompted();
  const prompter = createPrompter();
  try {
    return await askEach(available, (question, def) => prompter.confirm(question, def));
  } finally {
    prompter.close();
  }
}

export interface InstallOptions {
  brand: Brand;
  plugin: string;
  ref?: string;
  /** Harness names, `all`, or nothing for "ask". */
  targets?: readonly string[] | null;
  force?: boolean;
  assumeYes?: boolean;
  deps?: Deps;
  /** HarnessOpts, not PathOpts: this is forwarded to the harnesses, runner and all. */
  pathOpts?: HarnessOpts;
  /** Shared per-run work; `update` threads one through every plugin. */
  session?: Session;
}

export async function installPlugin({
  brand,
  plugin,
  ref,
  targets,
  force = false,
  assumeYes = false,
  deps = {},
  pathOpts,
  session,
}: InstallOptions): Promise<InstallResult> {
  const ownSession = !session;
  const run = session || createSession({ deps, notify: announceMarketplace });
  const progress = { stage: 'resolve' as Stage };
  try {
    return await runInstall({
      brand,
      plugin,
      ref,
      targets,
      force,
      assumeYes,
      deps,
      pathOpts,
      run,
      progress,
    });
  } catch (err) {
    trackFailure(sinkOf(deps), EVENTS.installFailed, {
      plugin,
      brand,
      stage: progress.stage,
      err,
    });
    throw err;
  } finally {
    if (ownSession) await run.cleanup();
  }
}

interface RunInstallArgs extends InstallOptions {
  force: boolean;
  assumeYes: boolean;
  deps: Deps;
  run: Session;
  /** Written as the run advances, so the wrapper can say where a throw came from. */
  progress: { stage: Stage };
}

async function runInstall({
  brand,
  plugin,
  ref,
  targets,
  force,
  assumeYes,
  deps,
  pathOpts,
  run,
  progress,
}: RunInstallArgs): Promise<InstallResult> {
  assertPlugin(plugin);
  const track = sinkOf(deps);
  const startedAt = Date.now();
  const effectiveRef = ref || brand.ref;
  const records = openManifest(paths.manifestPath(pathOpts));

  const catalog = orThrow(await run.catalog({ repo: brand.repo, ref: effectiveRef }));
  const resolved = orThrow(
    resolvePlugin(catalog, {
      plugin,
      repo: brand.repo,
      ref: effectiveRef,
      marketplace: brand.id,
      label: brand.label,
    }),
  );

  progress.stage = 'harnesses';
  const requested = orThrow(resolveTargets(targets));
  const conflict = force ? null : records.conflictFor({ plugin, repo: brand.repo });
  if (conflict) throw new UserError(conflict.message, { hint: conflict.hint });
  const recorded = records.find({ plugin, repo: brand.repo });

  const from = effectiveRef === 'main' ? brand.label : `${brand.label} (${effectiveRef})`;
  log.banner(`Installing '${plugin}' from ${from}`);
  log.debug(`source: ${brand.repo}@${effectiveRef}, marketplace: ${resolved.marketplace}`);
  if (resolved.description) log.info(resolved.description);
  log.rule();

  log.step('[Harnesses]');
  const explicit = Array.isArray(targets) && targets.length > 0;
  const available = requested.filter((name) => byName(name).detect(pathOpts));
  const missing = requested.filter((name) => !available.includes(name));

  for (const name of missing) {
    const h = byName(name);
    log.info(`${h.title} is not installed (looked in ${h.location(pathOpts)}).`);
  }

  if (!available.length) {
    const names = missing.map((n) => byName(n).title);
    throw new UserError(
      explicit
        ? `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} not installed on this machine.`
        : 'No supported editor found on this machine.',
      {
        hint: explicit
          ? `Install it first, or choose another with --targets ${NAMES.join(',')}.`
          : `Install ${everyEditor('or')}, then run this again.`,
      },
    );
  }
  if (missing.length) {
    log.info(`Continuing with ${titlesOf(available)}.`);
  }

  let prompted = false;
  const want = await chooseHarnesses(available, {
    explicit,
    assumeYes,
    confirm: deps.confirm,
    onPrompted: () => {
      prompted = true;
    },
  });
  // Closes the prompt flow's connector when one was drawn.
  const closeGroup = (msg: string) => (prompted ? log.groupEnd(msg) : log.info(msg));
  if (!want.length) {
    if (prompted) log.groupEnd('No harness selected - nothing was installed.');
    else {
      log.plain('');
      log.warn('No harness selected - nothing was installed.');
    }
    return { plugin, targets: [], marketplace: resolved.marketplace, ref: effectiveRef };
  }
  closeGroup(`Installing into: ${titlesOf(want)}`);

  // Editors an earlier run installed into that this run skips. Their copies are
  // still on disk, so they stay on the record or `update` would never refresh them.
  const untouched = (recorded?.targets ?? []).filter((n) => !want.includes(n));

  const needsSource = want.some((name) => byName(name).needsSource);
  let srcDir: string | null = null;
  if (needsSource) {
    progress.stage = 'fetch';
    log.step('[Fetch]');
    srcDir = orThrow(
      await run.source({
        repo: brand.repo,
        ref: effectiveRef,
        sourcePath: resolved.sourcePath,
      }),
    );
    log.ok('Plugin source ready');
  }

  progress.stage = 'install';
  const installed: HarnessName[] = [];
  for (const name of want) {
    const harness = byName(name);
    log.step(`[${harness.title}]`);
    const ctx: HarnessContext = {
      plugin,
      marketplace: resolved.marketplace,
      repo: brand.repo,
      srcDir,
      session: run,
    };
    if (harness.needsSource && !ctx.srcDir) {
      log.warn(`${harness.title} not detected - skipping.`);
      continue;
    }
    if (await harness.install(ctx, pathOpts)) installed.push(name);
  }

  if (installed.length) {
    records.recordInstall({
      plugin,
      repo: brand.repo,
      marketplace: resolved.marketplace,
      ref: effectiveRef,
      installed,
      untouched,
    });
  }

  for (const name of installed) {
    track(EVENTS.installed, {
      plugin,
      harness: name,
      marketplace: marketplaceLabel(brand),
      targets_explicit: explicit,
      duration_ms: Date.now() - startedAt,
    });
  }

  summarize(installed, 'Installed into', untouched);

  return {
    plugin,
    targets: installed,
    untouched,
    marketplace: resolved.marketplace,
    ref: effectiveRef,
  };
}

export interface UninstallOptions {
  brand: Brand;
  plugin: string;
  targets?: readonly string[] | null;
  /** Clear the record even for editors that could not confirm the removal. */
  force?: boolean;
  deps?: Deps;
  pathOpts?: HarnessOpts;
}

export async function uninstallPlugin(options: UninstallOptions): Promise<UninstallResult> {
  const track = sinkOf(options.deps);
  try {
    const result = await runUninstall(options);
    // Before the failure below, so a partial uninstall still reports what it did.
    for (const name of result.targets) {
      track(EVENTS.uninstalled, {
        plugin: result.plugin,
        harness: name,
        marketplace: marketplaceLabel(options.brand),
      });
    }
    // Asked and went wrong is not a clean uninstall, however much else worked.
    if (result.failed.length) {
      throw new UserError(
        `Could not uninstall '${result.plugin}' from ${titlesOf(result.failed)}.`,
        { hint: 'Close the editor if it is running, then try again - or --verbose for detail.' },
      );
    }
    return result;
  } catch (err) {
    trackFailure(track, EVENTS.uninstallFailed, {
      plugin: options.plugin,
      brand: options.brand,
      err,
    });
    throw err;
  }
}

async function runUninstall({
  brand,
  plugin,
  targets,
  force = false,
  deps = {},
  pathOpts,
}: UninstallOptions): Promise<UninstallResult> {
  assertPlugin(plugin);
  const records = openManifest(paths.manifestPath(pathOpts));
  const key = { plugin, repo: brand.repo };
  // The raw row: uninstall must also clear rows the sanitized view hides, and
  // their recorded marketplace is what keeps the Claude path offline.
  const recorded = records.findRaw(key);
  const want = orThrow(resolveTargets(targets));

  let marketplace: string | null =
    brand.id || (recorded && nonEmptyString(recorded.marketplace) ? recorded.marketplace : null);
  if (!marketplace && want.includes('claude')) {
    try {
      const catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
      marketplace = orThrow(
        resolvePlugin(catalog, { plugin, repo: brand.repo, ref: brand.ref }),
      ).marketplace;
    } catch (err) {
      // With a record to correct, reaching the registry must not block cleaning
      // it up; with none, the error and its suggestion are the useful answer.
      if (!recorded) throw err;
      log.warn(
        `Could not look up the marketplace for '${plugin}' - continuing. ${errorMessage(err)}`,
      );
    }
  }

  log.banner(`Uninstalling '${plugin}' from ${brand.label}`);
  log.info(`Removing from: ${titlesOf(want)}`);
  log.rule();

  // One entry per editor visited. `decideUninstall` derives everything the
  // record and the summary say from exactly this, so the two cannot disagree.
  const outcomes = new Map<HarnessName, UninstallOutcome>();

  for (const name of want) {
    const harness = byName(name);
    log.step(`[${harness.title}]`);
    try {
      outcomes.set(
        name,
        await harness.uninstall({ plugin, marketplace, repo: brand.repo }, pathOpts),
      );
    } catch (err) {
      // One editor's I/O failure is not the others' business.
      log.warn(`${harness.title}: ${errorMessage(err)}`);
      outcomes.set(name, 'failed');
    }
  }

  const decision = decideUninstall({ recorded: recorded ?? null, outcomes, want, force });

  records.applyUninstall(key, decision);

  // Nothing to say means a failure the thrown error reports; no empty framing.
  const lines = uninstallLines(decision, { plugin, bin: BIN });
  if (lines.length) {
    log.plain('');
    log.rule();
    for (const line of lines) log[line.level](line.text);
    log.plain('');
  }

  return { plugin, targets: decision.removed, failed: decision.failed };
}

export interface UpdateOptions {
  brand: Brand;
  deps?: Deps;
  pathOpts?: HarnessOpts;
}

export async function updateAll({
  brand,
  deps = {},
  pathOpts,
}: UpdateOptions): Promise<UpdateResult> {
  const { plugins: entries, ignored, elided } = openManifest(paths.manifestPath(pathOpts)).read();
  if (!entries.length && !ignored.length) {
    log.warn('No plugins installed yet - nothing to update.');
    return { updated: [], failed: [] };
  }

  log.banner(`Updating ${log.plural(entries.length + ignored.length, 'plugin')}`);
  log.plain('');
  const updated: string[] = [];
  const failed: UpdateResult['failed'] = [];
  // One line per plugin instead of a full install report each, unless --verbose.
  const collapse = !log.isVerbose && !log.isQuiet;
  const names = [...entries, ...ignored].map((e) => (e.plugin || '').length);
  const idWidth = Math.min(Math.max(...names, 4), 42);

  for (const skip of ignored) {
    const name = skip.plugin || '(unreadable entry)';
    failed.push({ plugin: name, error: `cannot update - ${skip.reason}` });
    log.error(`${name.padEnd(idWidth)}  cannot update - ${skip.reason}`);
  }
  // Not a failure: the row updates for the targets this build knows, and the
  // ones it does not are written back untouched.
  for (const row of elided) {
    log.warn(
      `${row.plugin.padEnd(idWidth)}  not updating unknown target(s): ${row.targets.join(', ')}`,
    );
  }

  const session = createSession({ deps, notify: announceMarketplace });
  try {
    for (const entry of entries) {
      const entryBrand: Brand = Object.freeze({
        ...brand,
        repo: entry.repo || brand.repo,
        ref: entry.ref || brand.ref,
        id: entry.marketplace || brand.id,
      });
      // Nowhere to refresh it: a skip, not the failure that would make `update`
      // exit 1 on this row forever.
      const reachable = entry.targets.filter((n) => byName(n).detect(pathOpts));
      if (!reachable.length) {
        log.warn(`${entry.plugin.padEnd(idWidth)}  no editor for it on this machine - skipping`);
        continue;
      }
      if (collapse) log.setQuiet(true);
      try {
        const result = await installPlugin({
          brand: entryBrand,
          plugin: entry.plugin,
          ref: entry.ref,
          targets: reachable,
          force: true,
          assumeYes: true,
          deps,
          pathOpts,
          session,
        });
        if (collapse) log.setQuiet(false);
        updated.push(entry.plugin);
        const where = titlesOf(result.targets);
        if (collapse) log.ok(`${entry.plugin.padEnd(idWidth)}  ${log.dim(where)}`);
      } catch (err) {
        if (collapse) log.setQuiet(false);
        failed.push({ plugin: entry.plugin, error: errorMessage(err) });
        log.error(`${entry.plugin.padEnd(idWidth)}  ${errorMessage(err)}`);
      }
    }
  } finally {
    await session.cleanup();
  }

  log.plain('');
  log.rule();
  if (failed.length) {
    log.warn(
      `Updated ${updated.length} of ${entries.length + ignored.length}; failed: ${failed.map((f) => f.plugin).join(', ')}`,
    );
  } else {
    log.ok(`Updated ${log.plural(updated.length, 'plugin')}`);
  }
  log.plain('');
  return { updated, failed };
}

export interface ListOptions {
  brand: Brand;
  deps?: Deps;
  pathOpts?: HarnessOpts;
}

export async function listPlugins({
  brand,
  deps = {},
  pathOpts,
}: ListOptions): Promise<ListResult> {
  const catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
  if (!catalog) {
    throw new UserError(`Could not read ${brand.label}.`, {
      hint: 'Check --repo, or the branch you pointed at with --ref.',
    });
  }
  const targetsByPlugin = new Map(
    openManifest(paths.manifestPath(pathOpts))
      .list()
      .filter((p) => RepoSlug.same(p.repo, brand.repo))
      .map((p): [string, HarnessName[]] => [p.plugin, p.targets]),
  );
  return {
    label: brand.label,
    marketplace: catalog.marketplace,
    repo: brand.repo,
    plugins: catalog.plugins.map((p) => {
      const name = typeof p === 'string' ? p : p.name;
      const targets = targetsByPlugin.get(name) || [];
      return {
        name,
        description: typeof p === 'object' && nonEmptyString(p.description) ? p.description : '',
        targets,
        installed: targets.length > 0,
      };
    }),
  };
}

function summarize(done: HarnessName[], verb: string, unchanged: HarnessName[] = []): void {
  log.plain('');
  log.rule();
  if (!done.length) {
    log.warn(nothingChanged());
  } else {
    log.ok(`${verb}: ${titlesOf(done)}`);
  }
  if (unchanged.length) log.info(`Already installed: ${titlesOf(unchanged)}`);
  log.plain('');
}
