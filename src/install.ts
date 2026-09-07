import type { InstallRequest } from './actions/install.js';
import type { UninstallRequest } from './actions/uninstall.js';
import { loadCatalog } from './catalog.js';
import { InstallCommand } from './commands/install.js';
import { UninstallCommand } from './commands/uninstall.js';
import { harnesses } from './harnesses/index.js';
import { openManifest } from './infrastructure/manifest-store.js';
import * as paths from './infrastructure/paths.js';
import { createSession } from './infrastructure/session.js';
import { log } from './log.js';
import { announceMarketplace } from './prompts/marketplace.js';
import type { Brand } from './types/brand.js';
import { titlesOf, type HarnessName, type HarnessOpts } from './types/harness.js';
import { RepoSlug } from './types/ids/repo-slug.js';
import type { Deps } from './types/ports.js';
import type { InstallResult, ListResult, UninstallResult, UpdateResult } from './types/reports.js';
import type { Session } from './types/session.js';
import type { TrackFn } from './types/telemetry.js';
import { errorMessage, nonEmptyString, throwFailure, UserError } from './util.js';

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

/**
 * The install path is `commands/install.ts` over `actions/install.ts` now; this
 * is the shim `update` and `cli.ts` still call.
 */
export type InstallOptions = InstallRequest & {
  /** Shared per-run work; `update` threads one through every plugin. */
  session?: Session;
};

export async function installPlugin({ session, ...req }: InstallOptions): Promise<InstallResult> {
  const ownSession = !session;
  const run = session || createSession({ deps: req.deps, notify: announceMarketplace });
  try {
    const result = await new InstallCommand(sinkOf(req.deps)).run(req, run);
    if (result.failure) throwFailure(result.failure);
    return result.report;
  } finally {
    if (ownSession) await run.cleanup();
  }
}

/**
 * The uninstall path is `commands/uninstall.ts` over `actions/uninstall.ts`
 * now; this is the shim `update` and `cli.ts` still call, and it goes with
 * `updateAll` in the next slice.
 */
export type UninstallOptions = UninstallRequest;

export async function uninstallPlugin(options: UninstallOptions): Promise<UninstallResult> {
  const result = await new UninstallCommand(sinkOf(options.deps)).run(options);
  if (result.failure) throwFailure(result.failure);
  return result.report;
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
      const reachable = harnesses.detected(entry.targets, pathOpts);
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
