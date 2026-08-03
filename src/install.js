'use strict';

const log = require('./log');
const paths = require('./paths');
const manifest = require('./manifest');
const { resolvePlugin, loadCatalog } = require('./catalog');
const { createSession } = require('./session');
const { createTelemetry, classifyError } = require('./telemetry');
const { DEFAULT_PROFILE } = require('./brand');
const { byName, resolveTargets, NAMES } = require('./harness');
const { isInteractive, createPrompter } = require('./prompt');
const { assertPlugin, UserError } = require('./util');

const nowIso = () => new Date().toISOString();

async function askEach(names, ask) {
  const chosen = [];
  for (const name of names) {
    if (await ask(`Install into ${byName(name).title}?`, true)) chosen.push(name);
  }
  return chosen;
}

/**
 * Nothing is installed into an assistant the user did not agree to.
 *
 * The question is skipped when the answer is already known: an explicit
 * --targets is a decision, --yes opts out, and a non-interactive shell has
 * nobody to ask (so it uses every detected assistant rather than hanging).
 *
 * Returns which harnesses were chosen *and* how, because "the user said no to
 * Cursor" and "nobody was asked" are the same empty answer otherwise.
 */
async function chooseHarnesses(available, { explicit = false, assumeYes = false, confirm } = {}) {
  if (!available.length) return { chosen: available, source: 'nothing_detected' };
  if (explicit) return { chosen: available, source: 'explicit_targets' };
  if (assumeYes) return { chosen: available, source: 'assume_yes' };

  if (confirm) return { chosen: await askEach(available, confirm), source: 'interactive' };

  if (!isInteractive()) {
    log.info('Non-interactive shell - using every detected harness (--targets to choose).');
    return { chosen: available, source: 'non_interactive' };
  }

  const prompter = createPrompter();
  try {
    return {
      chosen: await askEach(available, (question, def) => prompter.confirm(question, def)),
      source: 'interactive',
    };
  } finally {
    prompter.close();
  }
}

/**
 * The same plugin id can exist in more than one marketplace, and Cursor/VS Code
 * both place plugins in a flat <plugin>/ directory - so a second install would
 * silently overwrite the first. Refuse instead, unless the user forces it.
 */
function assertNoMarketplaceConflict(manifestFile, { plugin, repo }, force) {
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

/**
 * What one install reported, filled in as the run proceeds so a failure still
 * says how far it got - which editors were found, which the user agreed to, and
 * whether the files came from a clone or the API.
 */
function newRecord({ plugin, trigger, brand }) {
  return {
    plugin,
    trigger,
    // "Not the marketplace we ship with", as a flag: the repository name itself
    // can be a private one, and is nobody's business but the user's.
    custom_marketplace: Boolean(brand && brand.repo !== DEFAULT_PROFILE.repo),
    prompt_source: null,
    detected_harnesses: [],
    accepted_harnesses: [],
    declined_harnesses: [],
    installed_harnesses: [],
    fetch_via: 'none',
    fetch_duration_ms: null,
  };
}

/**
 * An install ends up in exactly one of these. Nothing accepted means the user
 * declined every editor, which is a different thing from an install that was
 * attempted and came up short.
 */
function outcomeOf({ accepted_harnesses: accepted, installed_harnesses: installed }) {
  if (!accepted.length) return 'no_harness_selected';
  return installed.length === accepted.length ? 'success' : 'partial';
}

/**
 * `session` carries the work that is the same for every plugin in a run (the
 * registry, the clone, the Claude marketplace registration). `update` passes one
 * in so that work happens once; a lone `install` gets a throwaway session and
 * behaves exactly as before. `update` also passes its own telemetry, so a run of
 * ten plugins flushes once instead of ten times.
 */
async function installPlugin({
  brand,
  plugin,
  ref,
  targets,
  force = false,
  assumeYes = false,
  deps = {},
  pathOpts,
  session,
  trigger = 'install',
} = {}) {
  const ownSession = !session;
  const run = session || createSession({ deps });
  const telemetry = deps.telemetry || createTelemetry({ pathOpts, env: deps.env });
  const record = newRecord({ plugin, trigger, brand });
  const startedAt = Date.now();
  try {
    const result = await runInstall({
      brand,
      plugin,
      ref,
      targets,
      force,
      assumeYes,
      deps,
      pathOpts,
      run,
      record,
    });
    telemetry.track('Install', {
      ...record,
      outcome: outcomeOf(record),
      error_code: null,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    telemetry.track('Install', {
      ...record,
      outcome: 'error',
      error_code: classifyError(err),
      duration_ms: Date.now() - startedAt,
    });
    throw err;
  } finally {
    if (ownSession) await run.cleanup();
    if (!deps.telemetry) await telemetry.flush();
  }
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
  record,
}) {
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

  const from = effectiveRef === 'main' ? brand.label : `${brand.label} (${effectiveRef})`;
  log.banner(`Installing '${plugin}' from ${from}`);
  log.debug(`source: ${brand.repo}@${effectiveRef}, marketplace: ${resolved.marketplace}`);
  if (resolved.description) log.info(resolved.description);
  log.rule();

  log.step('[Harnesses]');
  const explicit = Array.isArray(targets) && targets.length > 0;
  const available = requested.filter((name) => byName(name).detect(pathOpts));
  const missing = requested.filter((name) => !available.includes(name));
  record.detected_harnesses = available;

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

  const { chosen: want, source: promptSource } = await chooseHarnesses(available, {
    explicit,
    assumeYes,
    confirm: deps.confirm,
  });
  record.prompt_source = promptSource;
  record.accepted_harnesses = want;
  record.declined_harnesses = available.filter((name) => !want.includes(name));
  if (!want.length) {
    log.plain('');
    log.warn('No harness selected - nothing was installed.');
    return { plugin, targets: [], marketplace: resolved.marketplace, ref: effectiveRef };
  }
  log.info(`Installing into: ${want.map((n) => byName(n).title).join(', ')}`);

  // Only pay for the fetch if a chosen harness needs the files. The session
  // owns the clone, so a second plugin from the same repo checks out locally.
  const needsSource = want.some((name) => byName(name).needsSource);
  let srcDir = null;
  if (needsSource) {
    log.step('[Fetch]');
    const fetchStartedAt = Date.now();
    srcDir = await run.source({
      repo: brand.repo,
      ref: effectiveRef,
      sourcePath: resolved.sourcePath,
    });
    // During `update` the session already holds the clone, so this is the cost
    // of one checkout rather than one fetch - which is the point of measuring it.
    record.fetch_duration_ms = Date.now() - fetchStartedAt;
    record.fetch_via = run.via({ repo: brand.repo, ref: effectiveRef }) || 'unknown';
    log.ok('Plugin source ready');
  }

  const installed = [];
  for (const name of want) {
    const harness = byName(name);
    log.step(`[${harness.title}]`);
    const ctx = {
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
  record.installed_harnesses = installed;

  if (installed.length) {
    manifest.upsert(manifestFile, {
      plugin,
      repo: brand.repo,
      marketplace: resolved.marketplace,
      ref: effectiveRef,
      targets: installed,
      installedAt: nowIso(),
    });
  }

  summarize(installed, 'Installed into');

  return { plugin, targets: installed, marketplace: resolved.marketplace, ref: effectiveRef };
}

/**
 * How long the plugin sat installed before this uninstall, or null when the
 * manifest cannot say - an entry written by an older version, or one already
 * gone. An uninstall minutes after the install means something different from
 * one months later.
 */
function sinceInstall(recorded) {
  const at = recorded && recorded.installedAt ? Date.parse(recorded.installedAt) : NaN;
  return Number.isNaN(at) ? null : Date.now() - at;
}

async function uninstallPlugin({ brand, plugin, targets, deps = {}, pathOpts } = {}) {
  assertPlugin(plugin);
  const telemetry = deps.telemetry || createTelemetry({ pathOpts, env: deps.env });
  const manifestFile = paths.manifestPath(pathOpts);
  const recorded = manifest.find(manifestFile, { plugin, repo: brand.repo });
  const want = resolveTargets(targets);

  // Prefer the recorded marketplace so uninstall works offline.
  let marketplace = brand.id || (recorded && recorded.marketplace) || null;
  if (!marketplace && want.includes('claude')) {
    marketplace = (
      await resolvePlugin({ repo: brand.repo, ref: brand.ref, plugin, deps })
    ).marketplace;
  }

  log.banner(`Uninstalling '${plugin}' from ${brand.label}`);
  log.info(`Removing from: ${want.map((n) => byName(n).title).join(', ')}`);
  log.rule();

  const timeSinceInstall = sinceInstall(recorded);
  const removed = [];
  try {
    for (const name of want) {
      const harness = byName(name);
      log.step(`[${harness.title}]`);
      if (await harness.uninstall({ plugin, marketplace, repo: brand.repo }, pathOpts)) {
        removed.push(name);
      }
    }

    const remaining = (recorded ? recorded.targets || [] : []).filter((t) => !removed.includes(t));
    if (recorded && remaining.length === 0) {
      manifest.remove(manifestFile, { plugin, repo: brand.repo });
    } else if (recorded) {
      manifest.upsert(manifestFile, { ...recorded, targets: remaining });
    }

    telemetry.track('Uninstall', {
      plugin,
      targets: want,
      removed_harnesses: removed,
      time_since_install_ms: timeSinceInstall,
    });

    summarize(removed, 'Uninstalled from');
    return { plugin, targets: removed };
  } finally {
    if (!deps.telemetry) await telemetry.flush();
  }
}

/** Re-install every recorded plugin, each with the repo/ref/targets it was installed with. */
async function updateAll({ brand, force = false, deps = {}, pathOpts } = {}) {
  const manifestFile = paths.manifestPath(pathOpts);
  const entries = manifest.list(manifestFile);
  if (!entries.length) {
    log.warn('No plugins installed yet - nothing to update.');
    return { updated: [], failed: [] };
  }

  log.banner(`Updating ${log.plural(entries.length, 'plugin')}`);
  log.plain('');
  const updated = [];
  const failed = [];
  // Each plugin would otherwise print a full install report; at five plugins
  // that is sixty lines of scrollback to find one failure in. Collapse to a
  // line each unless --verbose asked for the detail.
  const collapse = !log.isVerbose && !log.isQuiet;
  const idWidth = Math.min(Math.max(...entries.map((e) => e.plugin.length), 4), 42);

  // One session for the whole run: the registry is read once per marketplace,
  // each marketplace is cloned once, and Claude Code is told about it once -
  // instead of all three happening again for every plugin. The telemetry is
  // shared for the same reason: one flush at the end, not one per plugin.
  const session = createSession({ deps });
  const telemetry = deps.telemetry || createTelemetry({ pathOpts, env: deps.env });
  const runDeps = deps.telemetry ? deps : { ...deps, telemetry };
  try {
    for (const entry of entries) {
      const entryBrand = Object.freeze({
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
          deps: runDeps,
          pathOpts,
          session,
          trigger: 'update',
        });
        if (collapse) log.setQuiet(false);
        updated.push(entry.plugin);
        const where = (result.targets || []).map((n) => byName(n).title).join(', ');
        if (collapse) log.ok(`${entry.plugin.padEnd(idWidth)}  ${log.dim(where)}`);
      } catch (err) {
        if (collapse) log.setQuiet(false);
        failed.push({ plugin: entry.plugin, error: err.message });
        log.error(`${entry.plugin.padEnd(idWidth)}  ${err.message}`);
      }
    }
  } finally {
    await session.cleanup();
    if (!deps.telemetry) await telemetry.flush();
  }

  log.plain('');
  log.rule();
  if (failed.length) {
    log.warn(`Updated ${updated.length} of ${entries.length}; failed: ${failed.map((f) => f.plugin).join(', ')}`);
  } else {
    log.ok(`Updated ${log.plural(updated.length, 'plugin')}`);
  }
  log.plain('');
  return { updated, failed };
}

async function listPlugins({ brand, deps = {}, pathOpts } = {}) {
  const catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
  if (!catalog) {
    throw new UserError(`Could not read ${brand.label}.`, {
      hint: 'Check --repo, or the branch you pointed at with --ref.',
    });
  }
  const installed = new Set(
    manifest
      .list(paths.manifestPath(pathOpts))
      .filter((p) => (p.repo || '') === brand.repo)
      .map((p) => p.plugin),
  );
  return {
    label: brand.label,
    marketplace: catalog.marketplace,
    repo: brand.repo,
    plugins: catalog.plugins.map((p) => {
      const name = typeof p === 'string' ? p : p.name;
      return {
        name,
        description: (typeof p === 'object' && p.description) || '',
        installed: installed.has(name),
      };
    }),
  };
}

function summarize(done, verb) {
  log.plain('');
  log.rule();
  if (!done.length) {
    log.warn('Nothing was changed. Are Claude Code / Cursor / VS Code installed?');
  } else {
    log.ok(`${verb}: ${done.map((n) => byName(n).title).join(', ')}`);
  }
  log.plain('');
}

module.exports = { installPlugin, uninstallPlugin, updateAll, listPlugins, chooseHarnesses };
