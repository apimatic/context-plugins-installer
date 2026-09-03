import { resolvePlugin, loadCatalog } from './catalog.js';
import {
  byName,
  resolveTargets,
  isHarnessName,
  titlesOf,
  everyEditor,
  NAMES,
} from './harness/index.js';
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
  HarnessOpts,
  InstallResult,
  ListResult,
  Session,
  TrackFn,
  UninstallOutcome,
  UninstallResult,
  UpdateResult,
} from './types.js';
import { assertPlugin, isPluginId, nonEmptyString, UserError, errorMessage } from './util.js';

const nowIso = (): string => new Date().toISOString();

/**
 * What a manifest row says this build should act on. `list` is a usable list of
 * target names; `unusable` is a row with nothing to act on per target (no
 * `targets`, or an empty one, which `read()` drops from its view anyway);
 * `foreign` is a target list this build cannot read - a shape it cannot parse,
 * or an array naming only names it does not know - which is never rebuilt and
 * never dropped without `--force`.
 */
type RowShape = 'none' | 'list' | 'unusable' | 'foreign';

function rowShape(recorded: Record<string, unknown> | null | undefined): RowShape {
  if (!recorded) return 'none';
  const { targets } = recorded;
  if (!Array.isArray(targets)) return targets == null ? 'unusable' : 'foreign';
  if (!targets.length) return 'unusable';
  // An array naming only targets this build does not know is exactly as
  // unreadable as a shape it cannot parse, and exactly as much another tool's
  // data - so it gets the same treatment, not a row that can never be dropped.
  // A normal uninstall produces this shape: `['cursor','zed']` becomes `['zed']`.
  return targets.some(isHarnessName) ? 'list' : 'foreign';
}

/** Everything the record and the summary are derived from. */
export interface UninstallFacts {
  /** The raw recorded row, exactly as it is on disk, or null for no row. */
  recorded: Record<string, unknown> | null;
  /** What each editor this run asked answered. */
  outcomes: ReadonlyMap<HarnessName, UninstallOutcome>;
  /** The editors this run asked. */
  want: readonly HarnessName[];
  force: boolean;
}

export interface UninstallDecision {
  /** Editors something was actually removed from. */
  removed: HarnessName[];
  /** Editors that were asked and went wrong. Non-empty means the run failed. */
  failed: HarnessName[];
  /** Recorded targets taken off the row because nothing was there. */
  cleared: HarnessName[];
  /** Recorded targets dropped by `--force` with nothing confirming them. */
  forced: HarnessName[];
  /** Known targets still on the row afterwards, however they got there. */
  stuck: HarnessName[];
  /** Target names this build cannot act on that went with the row anyway. */
  droppedUnknown: string[];
  write: 'none' | 'remove' | 'shorten';
  /** The `targets` a `shorten` writes back. */
  targets: unknown[];
  /** What the row looks like after the write; `none` once it is gone. */
  rowLeft: RowShape;
}

/**
 * What to write, and what to say about it. These used to be derived separately
 * from the same facts, and four review rounds each found another combination
 * where they disagreed or where the prose asserted something no editor had
 * established. One pure function now, over a state space small enough to
 * enumerate - `test/uninstall-decision.test.ts` asserts the invariants over all
 * of it, so a bad combination is a failing test rather than a later finding.
 */
export function decideUninstall({
  recorded,
  outcomes,
  want,
  force,
}: UninstallFacts): UninstallDecision {
  const of = (...kinds: UninstallOutcome[]): HarnessName[] =>
    [...outcomes].filter(([, o]) => kinds.includes(o)).map(([n]) => n);

  const row = rowShape(recorded);
  const listed: unknown[] = Array.isArray(recorded?.targets) ? recorded.targets : [];
  const onRow = (names: HarnessName[]): HarnessName[] => names.filter((n) => listed.includes(n));

  // `absent` clears too: the row is what drifted, not the run, and leaving it
  // would strand the plugin - unremovable, and failing every `update`.
  const clear = force ? [...outcomes.keys()] : of('removed', 'absent');
  // Foreign target names stay on the record for whichever tool wrote them.
  const remaining = listed.filter((t) => !clear.some((c) => c === t));

  // A row with no per-target list to shorten can only be dropped or kept whole,
  // so the bar is higher. `targets: []` reads as "every harness", which means
  // only a run that asked every harness - and got an answer from each - may
  // conclude the whole row is stale. A `targets` some other tool wrote is never
  // dropped on an inference at all; only an explicit `--force` may.
  const askedEveryEditor = NAMES.every((n) => want.includes(n));
  const answeredAll = of('failed', 'skipped').length === 0;
  let dropWhole = false;
  if (row === 'foreign') dropWhole = force;
  else if (row === 'unusable') dropWhole = force || (askedEveryEditor && answeredAll);

  const emptied = row === 'list' && remaining.length === 0;
  // A row `--force` would leave naming nothing this build can act on takes a
  // second, identical `--force` to go. One is enough: `--force` is already the
  // switch that accepts losing record fidelity, and it drops a row that arrived
  // in that state, so it should not stop half way to one.
  const strandedByForce = force && row === 'list' && !remaining.some(isHarnessName);
  const rowGone = Boolean(recorded) && (emptied || dropWhole || strandedByForce);
  const shorten = Boolean(recorded) && row === 'list' && remaining.length < listed.length;

  return {
    removed: of('removed'),
    failed: of('failed'),
    // What came off because an editor said there was nothing there. Under
    // --force it is not this: --force is then the reason any of it came off,
    // and only `forced` may speak for it.
    cleared: force ? [] : onRow(of('absent')),
    forced: force ? onRow([...outcomes.keys()]) : [],
    // Whatever this build still recognises on the row after the write, however
    // it got there - a target this run could not settle, or one it never asked
    // because `--targets` scoped it out.
    stuck: rowGone ? [] : remaining.filter(isHarnessName),
    // Named, never silent: this is another tool's data going out with the row.
    droppedUnknown: rowGone ? listed.filter((t) => !isHarnessName(t)).map(String) : [],
    write: rowGone ? 'remove' : shorten ? 'shorten' : 'none',
    targets: remaining,
    rowLeft:
      !recorded || rowGone
        ? 'none'
        : rowShape({ ...recorded, targets: row === 'list' ? remaining : recorded.targets }),
  };
}

export interface SummaryLine {
  level: 'ok' | 'warn' | 'info';
  text: string;
}

/**
 * One line per thing that actually happened, and nothing that did not. Pure, so
 * the exhaustive test reads what the user would be told for every reachable
 * combination rather than the handful someone thought to try.
 */
export function uninstallLines(
  { removed, cleared, forced, failed, stuck, rowLeft, write, droppedUnknown }: UninstallDecision,
  { plugin, bin }: { plugin: string; bin: string },
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (removed.length) lines.push({ level: 'ok', text: `Uninstalled from: ${titlesOf(removed)}` });
  if (cleared.length) {
    lines.push({
      level: 'ok',
      text: `Nothing was installed in ${titlesOf(cleared)} - cleared that from the record.`,
    });
  }
  if (forced.length) {
    lines.push({
      level: 'warn',
      text: `Dropped from the record without confirming removal: ${titlesOf(forced)}`,
    });
  }
  // A row that went for a reason none of the lines above covers: it named
  // nothing this build could act on, and every editor answered.
  if (write === 'remove' && !removed.length && !cleared.length && !forced.length) {
    lines.push({ level: 'ok', text: `Dropped the stale record for '${plugin}'.` });
  }
  if (droppedUnknown.length) {
    lines.push({
      level: 'warn',
      text: `Dropped target name(s) this version cannot act on: ${droppedUnknown.join(', ')}`,
    });
  }

  // A row this build can no longer act on at all. It has to be named: left
  // unmentioned, `read()` files it under `ignored` and `update` fails on it on
  // every future run, and clearing it takes a `--force` nothing asked for.
  const stranded = rowLeft === 'foreign' || rowLeft === 'unusable';
  // The scope is the stuck targets themselves, never the `--targets` of the run
  // that printed it: naming them exactly cannot widen what the user asked for.
  const scope = stuck.length ? ` --targets ${stuck.join(',')}` : '';
  const forceLine = `\`${bin} uninstall ${plugin}${scope} --force\` drops it without confirming.`;
  if (stranded) {
    lines.push({
      level: 'warn',
      text:
        rowLeft === 'foreign'
          ? `The record for '${plugin}' has a target list this version cannot read.`
          : `The record for '${plugin}' names no editor to remove from.`,
    });
    lines.push({ level: 'info', text: forceLine });
  } else if (stuck.length) {
    lines.push({
      level: 'info',
      text: `Still recorded for ${titlesOf(stuck)} - nothing here could confirm otherwise.`,
    });
    lines.push({ level: 'info', text: forceLine });
  }

  // "Are they installed?" is only the right question when nothing happened and
  // there is nothing else to say. A failure is a different answer, and the
  // thrown error names it, so no line here repeats it.
  if (!lines.length && !failed.length) {
    lines.push({ level: 'warn', text: `Nothing was changed. Are ${everyEditor()} installed?` });
  }
  return lines;
}

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
  pathOpts?: HarnessOpts;
}

export async function uninstallPlugin(options: UninstallOptions): Promise<UninstallResult> {
  const track = sinkOf(options.deps);
  try {
    const result = await runUninstall(options);
    // Reported before the failure below, so a partial uninstall is not counted
    // as nothing having happened.
    for (const name of result.targets) {
      track(EVENTS.uninstalled, {
        plugin: result.plugin,
        harness: name,
        marketplace: marketplaceLabel(options.brand),
      });
    }
    // An editor that was asked and went wrong is not a clean uninstall, however
    // much else succeeded - and a caller reading the exit code has to see that.
    // A `skipped` editor is not this: it was never there to fail.
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
  const manifestFile = paths.manifestPath(pathOpts);
  // The raw row: uninstall must also clear rows the sanitized view hides, and
  // their recorded marketplace is what keeps the Claude path offline.
  const recorded = manifest.findRaw(manifestFile, { plugin, repo: brand.repo });
  const want = resolveTargets(targets);

  let marketplace: string | null =
    brand.id || (recorded && nonEmptyString(recorded.marketplace) ? recorded.marketplace : null);
  if (!marketplace && want.includes('claude')) {
    try {
      marketplace = (await resolvePlugin({ repo: brand.repo, ref: brand.ref, plugin, deps }))
        .marketplace;
    } catch (err) {
      // With no record there is nothing to correct, so the resolution error -
      // a wrong id, with its suggestion - is the useful answer. With a record,
      // nothing about reaching the registry may stand between the user and
      // cleaning it up: offline, or after an upstream rename, `--force` has to
      // still work. Claude Code then reports a skip for want of a name.
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
      // One editor's I/O failure is not the others' business: a file held open
      // by a running Cursor must not leave the VS Code copy in place, and the
      // record still has to come out right for whoever did answer.
      log.warn(`${harness.title}: ${errorMessage(err)}`);
      outcomes.set(name, 'failed');
    }
  }

  const decision = decideUninstall({ recorded: recorded ?? null, outcomes, want, force });

  if (decision.write === 'remove') manifest.remove(manifestFile, { plugin, repo: brand.repo });
  else if (decision.write === 'shorten' && recorded) {
    manifest.upsert(manifestFile, { ...recorded, targets: decision.targets });
  }

  // No lines means the only thing that happened was a failure, which the thrown
  // error below reports - so the framing is skipped rather than drawn empty.
  const lines = uninstallLines(decision, { plugin, bin: brand.bin });
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
      // Nothing to refresh, and nowhere to refresh it: `installPlugin` would
      // throw "not installed on this machine" for an explicit target, which
      // would make `update` exit 1 on this row on every future run. It is a
      // skip - the copy, if any, is wherever the uninstalled editor left it.
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
    log.warn(`Nothing was changed. Are ${everyEditor()} installed?`);
  } else {
    log.ok(`${verb}: ${titlesOf(done)}`);
  }
  if (unchanged.length) log.info(`Already installed: ${titlesOf(unchanged)}`);
  log.plain('');
}
