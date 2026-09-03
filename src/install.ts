import { resolvePlugin, loadCatalog } from './catalog.js';
import { byName, resolveTargets, NAMES } from './harness/index.js';
import { log } from './log.js';
import * as manifest from './manifest.js';
import * as paths from './paths.js';
import { isInteractive, createPrompter } from './prompt.js';
import { createSession } from './session.js';
import { EVENTS, marketplaceLabel } from './telemetry.js';
import type {
  Brand,
  Deps,
  HarnessContext,
  HarnessName,
  InstallResult,
  ListResult,
  PathOpts,
  Session,
  TrackFn,
  UninstallResult,
  UpdateResult,
} from './types.js';
import { assertPlugin, isPluginId, nonEmptyString, UserError, errorMessage } from './util.js';

const nowIso = (): string => new Date().toISOString();

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
    plugin: isPluginId(plugin) ? plugin : null,
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

// An explicit --targets is a decision, --yes opts out, and a non-interactive
// shell has nobody to ask - so it takes every detected harness rather than hang.
export async function chooseHarnesses(
  available: HarnessName[],
  { explicit = false, assumeYes = false, confirm, onPrompted }: ChooseOptions = {},
): Promise<HarnessName[]> {
  if (!available.length || explicit || assumeYes) return available;

  if (confirm) return askEach(available, confirm);

  if (!isInteractive()) {
    log.info('Non-interactive shell - using every detected harness (--targets to choose).');
    return available;
  }

  if (onPrompted) onPrompted();
  const prompter = createPrompter();
  try {
    return await askEach(available, (question, def) => prompter.confirm(question, def));
  } finally {
    prompter.close();
  }
}

// Cursor and VS Code both keep plugins in a flat <plugin>/ directory, so the
// same id from a second marketplace would silently overwrite the first.
function assertNoMarketplaceConflict(
  manifestFile: string,
  { plugin, repo }: { plugin: string; repo: string },
  force: boolean,
): void {
  if (force) return;
  const clash = manifest
    .list(manifestFile)
    .find((p) => p.plugin === plugin && (p.repo || '') !== repo);
  if (clash) {
    throw new UserError(`'${plugin}' is already installed from a different marketplace.`, {
      hint: 'Uninstall it first, or re-run with --force to replace it.',
    });
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
  pathOpts?: PathOpts;
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
  const run = session || createSession({ deps });
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
  const manifestFile = paths.manifestPath(pathOpts);

  const resolved = await resolvePlugin({
    repo: brand.repo,
    ref: effectiveRef,
    plugin,
    marketplace: brand.id,
    label: brand.label,
    deps,
    catalog: await run.catalog({ repo: brand.repo, ref: effectiveRef }),
  });

  progress.stage = 'harnesses';
  const requested = resolveTargets(targets);
  assertNoMarketplaceConflict(manifestFile, { plugin, repo: brand.repo }, force);
  const recorded = manifest.find(manifestFile, { plugin, repo: brand.repo });
  // The raw row as well: the rewrite below must not drop what the sanitized view
  // hides. A row naming a harness only a newer CLI knows still belongs to it.
  const recordedRaw = manifest.findRaw(manifestFile, { plugin, repo: brand.repo });

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
          : 'Install Claude Code, Cursor, or VS Code, then run this again.',
      },
    );
  }
  if (missing.length) {
    log.info(`Continuing with ${available.map((n) => byName(n).title).join(', ')}.`);
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
  closeGroup(`Installing into: ${want.map((n) => byName(n).title).join(', ')}`);

  // Editors an earlier run installed into that this run skips. Their copies are
  // still on disk, so they stay on the record or `update` would never refresh them.
  const untouched = (recorded?.targets ?? []).filter((n) => !want.includes(n));

  const needsSource = want.some((name) => byName(name).needsSource);
  let srcDir: string | null = null;
  if (needsSource) {
    progress.stage = 'fetch';
    log.step('[Fetch]');
    srcDir = await run.source({
      repo: brand.repo,
      ref: effectiveRef,
      sourcePath: resolved.sourcePath,
    });
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
    const keep = new Set<HarnessName>([...untouched, ...installed]);
    manifest.upsert(manifestFile, {
      ...recordedRaw, // unknown fields ride along untouched
      plugin,
      repo: brand.repo,
      marketplace: resolved.marketplace,
      ref: effectiveRef,
      targets: [
        ...NAMES.filter((n) => keep.has(n)), // canonical order
        ...manifest.foreignTargets(recordedRaw),
      ],
      installedAt: nowIso(),
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
  pathOpts?: PathOpts;
}

export async function uninstallPlugin(options: UninstallOptions): Promise<UninstallResult> {
  const track = sinkOf(options.deps);
  try {
    const result = await runUninstall(options);
    for (const name of result.targets) {
      track(EVENTS.uninstalled, {
        plugin: result.plugin,
        harness: name,
        marketplace: marketplaceLabel(options.brand),
      });
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
  const manifestFile = paths.manifestPath(pathOpts);
  // The raw row: uninstall must also clear rows the sanitized view hides, and
  // their recorded marketplace is what keeps the Claude path offline.
  const recorded = manifest.findRaw(manifestFile, { plugin, repo: brand.repo });
  const want = resolveTargets(targets);

  let marketplace: string | null =
    brand.id || (recorded && nonEmptyString(recorded.marketplace) ? recorded.marketplace : null);
  if (!marketplace && want.includes('claude')) {
    marketplace = (await resolvePlugin({ repo: brand.repo, ref: brand.ref, plugin, deps }))
      .marketplace;
  }

  log.banner(`Uninstalling '${plugin}' from ${brand.label}`);
  log.info(`Removing from: ${want.map((n) => byName(n).title).join(', ')}`);
  log.rule();

  const removed: HarnessName[] = [];
  // Targets the record should no longer claim. An editor that had nothing to
  // remove belongs here too: the row is what drifted, not the run, and leaving
  // it would strand the plugin - unremovable, and failing every `update`.
  const clear: HarnessName[] = [];
  const failed: HarnessName[] = [];
  for (const name of want) {
    const harness = byName(name);
    log.step(`[${harness.title}]`);
    const outcome = await harness.uninstall({ plugin, marketplace, repo: brand.repo }, pathOpts);
    if (outcome === 'removed') removed.push(name);
    if (outcome !== 'failed' || force) clear.push(name);
    else failed.push(name);
  }

  // Foreign target names stay on the record for whichever tool wrote them.
  const recordedTargets: unknown[] =
    recorded && Array.isArray(recorded.targets) ? recorded.targets : [];
  const remaining = recordedTargets.filter((t) => !clear.some((c) => c === t));
  if (recorded && remaining.length === 0) {
    manifest.remove(manifestFile, { plugin, repo: brand.repo });
  } else if (recorded) {
    manifest.upsert(manifestFile, { ...recorded, targets: remaining });
  }

  summarizeUninstall({
    removed,
    plugin,
    cleared: Boolean(recorded) && remaining.length < recordedTargets.length,
    // Only what this run could not settle: a foreign target is also left
    // behind, on purpose, and --force does not clear it either.
    stuck: failed.some((n) => recordedTargets.includes(n)),
    bin: brand.bin,
  });
  return { plugin, targets: removed };
}

export interface UpdateOptions {
  brand: Brand;
  deps?: Deps;
  pathOpts?: PathOpts;
}

export async function updateAll({
  brand,
  deps = {},
  pathOpts,
}: UpdateOptions): Promise<UpdateResult> {
  const manifestFile = paths.manifestPath(pathOpts);
  const { plugins: entries, ignored, elided } = manifest.read(manifestFile);
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

  const session = createSession({ deps });
  try {
    for (const entry of entries) {
      const entryBrand: Brand = Object.freeze({
        ...brand,
        repo: entry.repo || brand.repo,
        ref: entry.ref || brand.ref,
        id: entry.marketplace || brand.id,
      });
      if (collapse) log.setQuiet(true);
      try {
        const result = await installPlugin({
          brand: entryBrand,
          plugin: entry.plugin,
          ref: entry.ref,
          targets: entry.targets,
          force: true,
          assumeYes: true,
          deps,
          pathOpts,
          session,
        });
        if (collapse) log.setQuiet(false);
        updated.push(entry.plugin);
        const where = result.targets.map((n) => byName(n).title).join(', ');
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
  pathOpts?: PathOpts;
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
    manifest
      .list(paths.manifestPath(pathOpts))
      .filter((p) => (p.repo || '') === brand.repo)
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

interface UninstallSummary {
  removed: HarnessName[];
  plugin: string;
  /** The record was corrected, whether or not this run removed anything. */
  cleared: boolean;
  /** A target this run could not confirm is still on the record. */
  stuck: boolean;
  bin: string;
}

function summarizeUninstall({ removed, plugin, cleared, stuck, bin }: UninstallSummary): void {
  log.plain('');
  log.rule();
  if (removed.length) {
    log.ok(`Uninstalled from: ${removed.map((n) => byName(n).title).join(', ')}`);
  } else if (cleared) {
    log.ok(`Nothing was installed - cleared the stale record for '${plugin}'.`);
  } else {
    log.warn('Nothing was changed. Are Claude Code / Cursor / VS Code installed?');
  }
  if (stuck) {
    log.info(
      `'${plugin}' is still on the record - \`${bin} uninstall ${plugin} --force\` clears it.`,
    );
  }
  log.plain('');
}

function summarize(done: HarnessName[], verb: string, unchanged: HarnessName[] = []): void {
  log.plain('');
  log.rule();
  if (!done.length) {
    log.warn('Nothing was changed. Are Claude Code / Cursor / VS Code installed?');
  } else {
    log.ok(`${verb}: ${done.map((n) => byName(n).title).join(', ')}`);
  }
  if (unchanged.length) {
    log.info(`Already installed: ${unchanged.map((n) => byName(n).title).join(', ')}`);
  }
  log.plain('');
}
