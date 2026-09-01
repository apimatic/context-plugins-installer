import { resolvePlugin, loadCatalog } from './catalog.js';
import { byName, resolveTargets, NAMES } from './harness/index.js';
import { log } from './log.js';
import * as manifest from './manifest.js';
import * as paths from './paths.js';
import { isInteractive, createPrompter } from './prompt.js';
import { createSession } from './session.js';
import type {
  Brand,
  Deps,
  HarnessContext,
  HarnessName,
  InstallResult,
  ListResult,
  PathOpts,
  Session,
  UninstallResult,
  UpdateResult,
} from './types.js';
import { assertPlugin, nonEmptyString, UserError, errorMessage } from './util.js';

const nowIso = (): string => new Date().toISOString();

type Ask = (question: string, defaultYes: boolean) => boolean | Promise<boolean>;

async function askEach(names: readonly HarnessName[], ask: Ask): Promise<HarnessName[]> {
  const chosen: HarnessName[] = [];
  for (const name of names) {
    if (await ask(`Install into ${byName(name).title}?`, true)) chosen.push(name);
  }
  return chosen;
}

export interface ChooseOptions {
  /** --targets was given: the user already decided. */
  explicit?: boolean;
  /** --yes: take every detected harness without asking. */
  assumeYes?: boolean;
  /** Headless answers (tests, embedders); bypasses the terminal prompter. */
  confirm?: Ask;
  /** Called once when the interactive flow is about to be drawn. */
  onPrompted?: () => void;
}

/**
 * Nothing is installed into an assistant the user did not agree to.
 *
 * The question is skipped when the answer is already known: an explicit
 * --targets is a decision, --yes opts out, and a non-interactive shell has
 * nobody to ask (so it uses every detected assistant rather than hanging).
 */
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

  // Only this branch draws the prompt flow, so only this branch leaves a connector
  // for the caller to close with `log.groupEnd`.
  if (onPrompted) onPrompted();
  const prompter = createPrompter();
  try {
    return await askEach(available, (question, def) => prompter.confirm(question, def));
  } finally {
    prompter.close();
  }
}

/**
 * The same plugin id can exist in more than one marketplace, and Cursor/VS Code
 * both place plugins in a flat <plugin>/ directory - so a second install would
 * silently overwrite the first. Refuse instead, unless the user forces it.
 */
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
  /** Overrides brand.ref for this install. */
  ref?: string;
  /** Harness names, `all`, or nothing for "ask". */
  targets?: readonly string[] | null;
  /** Replace a plugin installed from another marketplace. */
  force?: boolean;
  /** Accept every detected harness without asking. */
  assumeYes?: boolean;
  deps?: Deps;
  pathOpts?: PathOpts;
  /** Shared per-run work; `update` threads one through every plugin. */
  session?: Session;
}

/**
 * `session` carries the work that is the same for every plugin in a run (the
 * registry, the clone, the Claude marketplace registration). `update` passes one
 * in so that work happens once; a lone `install` gets a throwaway session and
 * behaves exactly as before.
 */
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
    });
  } finally {
    if (ownSession) await run.cleanup();
  }
}

interface RunInstallArgs extends InstallOptions {
  force: boolean;
  assumeYes: boolean;
  deps: Deps;
  run: Session;
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
}: RunInstallArgs): Promise<InstallResult> {
  assertPlugin(plugin);
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

  const requested = resolveTargets(targets);
  assertNoMarketplaceConflict(manifestFile, { plugin, repo: brand.repo }, force);
  const recorded = manifest.find(manifestFile, { plugin, repo: brand.repo });

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

  // Nothing to install into is a failure, not a quiet no-op. Saying which
  // editor was asked for beats a generic "no harness found" when the user
  // named one explicitly.
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
  // When the questions were drawn, this line closes their flow; otherwise nothing was
  // drawn to close and it stays the plain info line it has always been.
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

  // Editors this run skipped that an earlier one installed into. Install only ever
  // adds, so their copies are still on disk untouched - they stay on the record
  // below (or `update` would never refresh them again) and get a line in the
  // closing summary, which is where the user looks to see where the plugin lives.
  const untouched = (recorded?.targets ?? []).filter((n) => !want.includes(n));

  // Only pay for the fetch if a chosen harness needs the files. The session
  // owns the clone, so a second plugin from the same repo checks out locally.
  const needsSource = want.some((name) => byName(name).needsSource);
  let srcDir: string | null = null;
  if (needsSource) {
    log.step('[Fetch]');
    srcDir = await run.source({
      repo: brand.repo,
      ref: effectiveRef,
      sourcePath: resolved.sourcePath,
    });
    log.ok('Plugin source ready');
  }

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
    // The record is the union of what is on disk: what this run installed, plus the
    // editors an earlier run installed into that this one left alone. Writing only
    // `installed` would drop those, and `update` reads this list to decide what to
    // refresh - so a dropped editor becomes a copy that is never updated again.
    const keep = new Set<HarnessName>([...untouched, ...installed]);
    manifest.upsert(manifestFile, {
      plugin,
      repo: brand.repo,
      marketplace: resolved.marketplace,
      ref: effectiveRef,
      targets: NAMES.filter((n) => keep.has(n)), // canonical order, not call order
      installedAt: nowIso(),
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
  deps?: Deps;
  pathOpts?: PathOpts;
}

export async function uninstallPlugin({
  brand,
  plugin,
  targets,
  deps = {},
  pathOpts,
}: UninstallOptions): Promise<UninstallResult> {
  assertPlugin(plugin);
  const manifestFile = paths.manifestPath(pathOpts);
  // The raw view: uninstall must also clear rows the sanitized view hides
  // (targets recorded by a newer CLI, hand-edited typos), and their recorded
  // marketplace is what keeps the Claude path below off the network.
  const recorded = manifest.findRaw(manifestFile, { plugin, repo: brand.repo });
  const want = resolveTargets(targets);

  // Prefer the recorded marketplace so uninstall works offline.
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
  for (const name of want) {
    const harness = byName(name);
    log.step(`[${harness.title}]`);
    if (await harness.uninstall({ plugin, marketplace, repo: brand.repo }, pathOpts)) {
      removed.push(name);
    }
  }

  // Raw targets pass through untouched: a name this build does not know stays
  // on the record for whichever tool wrote it.
  const recordedTargets: unknown[] =
    recorded && Array.isArray(recorded.targets) ? recorded.targets : [];
  const remaining = recordedTargets.filter((t) => !removed.some((r) => r === t));
  if (recorded && remaining.length === 0) {
    manifest.remove(manifestFile, { plugin, repo: brand.repo });
  } else if (recorded) {
    manifest.upsert(manifestFile, { ...recorded, targets: remaining });
  }

  summarize(removed, 'Uninstalled from');
  return { plugin, targets: removed };
}

export interface UpdateOptions {
  brand: Brand;
  deps?: Deps;
  pathOpts?: PathOpts;
}

/** Re-install every recorded plugin, each with the repo/ref/targets it was installed with. */
export async function updateAll({
  brand,
  deps = {},
  pathOpts,
}: UpdateOptions): Promise<UpdateResult> {
  const manifestFile = paths.manifestPath(pathOpts);
  const { plugins: entries, ignored } = manifest.read(manifestFile);
  if (!entries.length && !ignored.length) {
    log.warn('No plugins installed yet - nothing to update.');
    return { updated: [], failed: [] };
  }

  log.banner(`Updating ${log.plural(entries.length + ignored.length, 'plugin')}`);
  log.plain('');
  const updated: string[] = [];
  const failed: UpdateResult['failed'] = [];
  // Each plugin would otherwise print a full install report; at five plugins
  // that is sixty lines of scrollback to find one failure in. Collapse to a
  // line each unless --verbose asked for the detail.
  const collapse = !log.isVerbose && !log.isQuiet;
  const names = [...entries, ...ignored].map((e) => (e.plugin || '').length);
  const idWidth = Math.min(Math.max(...names, 4), 42);

  // A row this build cannot read is a failed update, not an invisible one:
  // the plugin sits on disk, and this run is not refreshing it.
  for (const skip of ignored) {
    const name = skip.plugin || '(unreadable entry)';
    failed.push({ plugin: name, error: `cannot update - ${skip.reason}` });
    log.error(`${name.padEnd(idWidth)}  cannot update - ${skip.reason}`);
  }

  // One session for the whole run: the registry is read once per marketplace,
  // each marketplace is cloned once, and Claude Code is told about it once -
  // instead of all three happening again for every plugin.
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
          force: true, // the manifest is the source of truth here
          assumeYes: true, // never re-ask; the user already chose these harnesses
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
  // Per-plugin, not per-machine: a plugin recorded with targets: ['cursor'] is only
  // installed in Cursor, so `installed` must read that list rather than "does this
  // plugin appear anywhere in the manifest".
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

function summarize(done: HarnessName[], verb: string, unchanged: HarnessName[] = []): void {
  log.plain('');
  log.rule();
  if (!done.length) {
    log.warn('Nothing was changed. Are Claude Code / Cursor / VS Code installed?');
  } else {
    log.ok(`${verb}: ${done.map((n) => byName(n).title).join(', ')}`);
  }
  // An editor that already had the plugin and was skipped this run still has it, so
  // it belongs in the report - otherwise this reads as "it is only in these two".
  if (unchanged.length) {
    log.info(`Already installed: ${unchanged.map((n) => byName(n).title).join(', ')}`);
  }
  log.plain('');
}
