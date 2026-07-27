'use strict';

const log = require('./log');
const paths = require('./paths');
const manifest = require('./manifest');
const { resolvePlugin, loadCatalog } = require('./catalog');
const { materialize } = require('./fetch');
const { byName, resolveTargets } = require('./harness');
const { assertPlugin, UserError } = require('./util');

const nowIso = () => new Date().toISOString();

/**
 * Two marketplaces may ship the same plugin id, and Cursor/VS Code both place
 * plugins in a flat <plugin>/ directory - so the second install would silently
 * overwrite the first. Refuse instead, unless the user forces it.
 */
function assertNoCrossBrandCollision(manifestFile, { plugin, repo }, force) {
  if (force) return;
  const clash = manifest
    .list(manifestFile)
    .find((p) => p.plugin === plugin && (p.repo || '') !== repo);
  if (clash) {
    throw new UserError(
      `'${plugin}' is already installed from a different marketplace (${clash.repo}).`,
      { hint: `Uninstall it first, or re-run with --force to replace it.` },
    );
  }
}

async function installPlugin({
  brand,
  plugin,
  ref,
  targets,
  force = false,
  deps = {},
  pathOpts,
} = {}) {
  assertPlugin(plugin);
  const effectiveRef = ref || brand.ref;
  const manifestFile = paths.manifestPath(pathOpts);

  const resolved = await resolvePlugin({
    repo: brand.repo,
    ref: effectiveRef,
    plugin,
    marketplace: brand.id,
    deps,
  });

  const want = resolveTargets(targets);
  assertNoCrossBrandCollision(manifestFile, { plugin, repo: brand.repo }, force);

  log.banner(`Installing '${plugin}'  (marketplace: ${resolved.marketplace}, repo: ${brand.repo}@${effectiveRef})`);
  log.info(`Targets: ${want.join(', ')}`);
  if (resolved.description) log.info(resolved.description);
  log.rule();

  // Only pay for the fetch if a file-copy harness is actually present.
  const needsSource = want.some((name) => byName(name).needsSource && byName(name).detect(pathOpts));
  let source = null;
  if (needsSource) {
    log.step('[Fetch]');
    const materializeImpl = deps.materialize || materialize;
    source = await materializeImpl({
      repo: brand.repo,
      ref: effectiveRef,
      sourcePath: resolved.sourcePath,
      deps,
    });
    log.ok(`Plugin source ready (via ${source.via})`);
  }

  const installed = [];
  try {
    for (const name of want) {
      const harness = byName(name);
      log.step(`[${harness.title}]`);
      const ctx = {
        plugin,
        marketplace: resolved.marketplace,
        repo: brand.repo,
        srcDir: source ? source.dir : null,
      };
      if (harness.needsSource && !ctx.srcDir) {
        log.warn(`${harness.title} not detected - skipping.`);
        continue;
      }
      if (await harness.install(ctx, pathOpts)) installed.push(name);
    }
  } finally {
    if (source) source.cleanup();
  }

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

  log.banner(`Uninstalling '${plugin}'  (repo: ${brand.repo})`);
  log.info(`Targets: ${want.join(', ')}`);
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

/** Re-install every recorded plugin, each with the repo/ref/targets it was installed with. */
async function updateAll({ brand, force = false, deps = {}, pathOpts } = {}) {
  const manifestFile = paths.manifestPath(pathOpts);
  const entries = manifest.list(manifestFile);
  if (!entries.length) {
    log.warn(`Nothing recorded in ${manifestFile} - install a plugin first.`);
    return { updated: [], failed: [] };
  }

  log.banner(`Updating ${entries.length} plugin(s) from ${manifestFile}`);
  const updated = [];
  const failed = [];

  for (const entry of entries) {
    const entryBrand = Object.freeze({
      ...brand,
      repo: entry.repo || brand.repo,
      ref: entry.ref || brand.ref,
      id: entry.marketplace || brand.id,
    });
    try {
      await installPlugin({
        brand: entryBrand,
        plugin: entry.plugin,
        ref: entry.ref,
        targets: entry.targets,
        force: true, // the manifest is the source of truth here
        deps,
        pathOpts,
      });
      updated.push(entry.plugin);
    } catch (err) {
      failed.push({ plugin: entry.plugin, error: err.message });
      log.error(`${entry.plugin}: ${err.message}`);
    }
  }

  log.rule();
  log.ok(`Updated ${updated.length}/${entries.length}`);
  if (failed.length) log.warn(`Failed: ${failed.map((f) => f.plugin).join(', ')}`);
  return { updated, failed };
}

async function listPlugins({ brand, deps = {}, pathOpts } = {}) {
  const catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
  if (!catalog) {
    throw new UserError(`No marketplace registry found in ${brand.repo}@${brand.ref}.`, {
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
    log.warn('No harnesses were affected. Are Claude Code / Cursor / VS Code installed?');
  } else {
    log.ok(`${verb}: ${done.join(', ')}`);
  }
  log.plain('');
}

module.exports = { installPlugin, uninstallPlugin, updateAll, listPlugins };
