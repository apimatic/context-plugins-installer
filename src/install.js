'use strict';

const log = require('./log');
const paths = require('./paths');
const manifest = require('./manifest');
const { resolvePlugin, loadCatalog, pluginNames } = require('./catalog');
const { createSession } = require('./session');
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
 */
async function chooseHarnesses(
  available,
  { explicit = false, assumeYes = false, confirm, onPrompted } = {},
) {
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
 * `session` carries the work that is the same for every plugin in a run (the
 * registry, the clone, the Claude marketplace registration). `update` passes one
 * in so that work happens once; a lone `install` gets a throwaway session and
 * behaves exactly as before.
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
} = {}) {
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

async function runInstall({ brand, plugin, ref, targets, force, assumeYes, deps, pathOpts, run }) {
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
  const closeGroup = (msg) => (prompted ? log.groupEnd(msg) : log.info(msg));
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
  const untouched = (recorded ? recorded.targets || [] : []).filter((n) => !want.includes(n));

  // Only pay for the fetch if a chosen harness needs the files. The session
  // owns the clone, so a second plugin from the same repo checks out locally.
  const needsSource = want.some((name) => byName(name).needsSource);
  let srcDir = null;
  if (needsSource) {
    log.step('[Fetch]');
    srcDir = await run.source({
      repo: brand.repo,
      ref: effectiveRef,
      sourcePath: resolved.sourcePath,
    });
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

  if (installed.length) {
    // The record is the union of what is on disk: what this run installed, plus the
    // editors an earlier run installed into that this one left alone. Writing only
    // `installed` would drop those, and `update` reads this list to decide what to
    // refresh - so a dropped editor becomes a copy that is never updated again.
    const keep = new Set([...untouched, ...installed]);
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

async function uninstallPlugin({ brand, plugin, targets, deps = {}, pathOpts } = {}) {
  assertPlugin(plugin);
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

  const removed = [];
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

  summarize(removed, 'Uninstalled from');
  return { plugin, targets: removed };
}

/** "a", "a and b", "a, b and c" - for a sentence, where a comma list reads as a dump. */
function nameList(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Split recorded plugins into the ones their marketplace still lists and the
 * ones it does not.
 *
 * A plugin the registry has dropped is not a failure. It was removed or replaced
 * - and a replacement under a new id is a different plugin, not the same one
 * renamed - so there is nothing to refresh it from. The copy on disk keeps
 * working and stays where it is: removing it is the user's call, not ours.
 *
 * A registry that could not be read counts as *supported*. Reporting "no longer
 * supported" because of a network blip would be worse than the stale message it
 * replaces, so the ordinary install path handles that and reports the real error.
 *
 * The registry comes from the run's session, so this classifies off the same one
 * read per marketplace that the installs use rather than adding a fetch.
 */
async function partitionBySupport(entries, brand, session) {
  const listed = new Map(); // repo@ref -> Set of ids, or null when unreadable
  const supported = [];
  const unsupported = [];

  for (const entry of entries) {
    const repo = entry.repo || brand.repo;
    const ref = entry.ref || brand.ref;
    const key = `${repo}@${ref}`;
    if (!listed.has(key)) {
      let names = null;
      try {
        names = pluginNames(await session.catalog({ repo, ref }));
      } catch {
        names = null;
      }
      // An empty registry is indistinguishable from a broken one here, and
      // declaring every installed plugin dead is not a reasonable reading of it.
      listed.set(key, names && names.length ? new Set(names) : null);
    }
    const known = listed.get(key);
    if (known && !known.has(entry.plugin)) unsupported.push(entry);
    else supported.push(entry);
  }
  return { supported, unsupported };
}

/**
 * The closing block. Says what was not done, that nothing was deleted, and the
 * two commands that move the user forward - because the notice is the only place
 * they will learn any of it.
 */
function reportUnsupported(entries, brand) {
  const ids = entries.map((e) => e.plugin);
  const one = ids.length === 1;
  log.warn(`${nameList(ids)} ${one ? 'is' : 'are'} no longer supported by ${brand.displayName}.`);
  log.info(
    `Nothing was removed - ${one ? 'it is' : 'they are'} still on this machine and still ${one ? 'loads' : 'load'} in your editor.`,
  );
  log.info(`Run \`${brand.bin} list\` to see the plugins available now.`);
  log.info(`To remove ${one ? 'it' : 'one'}: ${brand.bin} uninstall ${ids[0]}`);
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
  // Filled by the partition inside the session, read again by the closing block.
  let supported = [];
  let unsupported = [];
  // Each plugin would otherwise print a full install report; at five plugins
  // that is sixty lines of scrollback to find one failure in. Collapse to a
  // line each unless --verbose asked for the detail.
  const collapse = !log.isVerbose && !log.isQuiet;
  const idWidth = Math.min(Math.max(...entries.map((e) => e.plugin.length), 4), 42);

  // One session for the whole run: the registry is read once per marketplace,
  // each marketplace is cloned once, and Claude Code is told about it once -
  // instead of all three happening again for every plugin.
  const session = createSession({ deps });
  try {
    // Classified up front, off the session's one registry read, so a de-listed
    // plugin never reaches the install path that would call it an error.
    // Skipped plugins print after the run: a clean block of what worked, then a
    // block of what needs the user, beats the two interleaved.
    const split = await partitionBySupport(entries, brand, session);
    supported = split.supported;
    unsupported = split.unsupported;

    for (const entry of supported) {
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
          deps,
          pathOpts,
          session,
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
  }

  for (const entry of unsupported) {
    log.note(`${entry.plugin.padEnd(idWidth)}  no longer supported by ${brand.displayName} - skipped`);
  }

  log.plain('');
  log.rule();
  if (failed.length) {
    log.warn(`Updated ${updated.length} of ${supported.length}; failed: ${failed.map((f) => f.plugin).join(', ')}`);
  } else if (unsupported.length) {
    log.ok(`Updated ${log.plural(updated.length, 'plugin')}. ${unsupported.length} skipped.`);
  } else {
    log.ok(`Updated ${log.plural(updated.length, 'plugin')}`);
  }
  if (unsupported.length) reportUnsupported(unsupported, brand);
  log.plain('');
  // `skipped` is deliberately not folded into `failed`: the exit code is the
  // difference between "your update did not work" and "these are not ours now".
  return { updated, failed, skipped: unsupported.map((e) => e.plugin) };
}

async function listPlugins({ brand, deps = {}, pathOpts, target } = {}) {
  if (target && !NAMES.includes(target)) {
    throw new UserError(`Unknown target: ${target}`, { hint: `Valid targets: ${NAMES.join(', ')}` });
  }
  const catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
  if (!catalog) {
    throw new UserError(`Could not read ${brand.label}.`, {
      hint: 'Check --repo, or the branch you pointed at with --ref.',
    });
  }
  // Per-plugin, not per-machine: a plugin recorded with targets: ['cursor'] is only
  // installed in Cursor, so `installed` (and an optional --target filter) must read
  // that list rather than "does this plugin appear anywhere in the manifest".
  const targetsByPlugin = new Map(
    manifest
      .list(paths.manifestPath(pathOpts))
      .filter((p) => (p.repo || '') === brand.repo)
      .map((p) => [p.plugin, p.targets || []]),
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
        description: (typeof p === 'object' && p.description) || '',
        targets,
        installed: target ? targets.includes(target) : targets.length > 0,
      };
    }),
  };
}

function summarize(done, verb, unchanged = []) {
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

module.exports = { installPlugin, uninstallPlugin, updateAll, listPlugins, chooseHarnesses };
