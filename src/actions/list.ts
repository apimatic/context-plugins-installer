import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import type { Brand } from '../types/brand.js';
import type { PathOpts } from '../types/env.js';
import { Failure } from '../types/failure.js';
import type { HarnessName } from '../types/harness.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type { Manifest } from '../types/installed-record.js';
import type { RegistryClient } from '../types/ports.js';
import type { ListReport, ListResult } from '../types/reports.js';
import type { MarketplaceListener } from '../types/session.js';
import { nonEmptyString } from '../types/util.js';
import { ActionResult } from './action-result.js';

export interface ListRequest {
  brand: Brand;
  pathOpts?: PathOpts;
}

/** Nothing was read, so there are no gaps to report either. */
const NO_GAPS: Manifest = { version: 0, plugins: [], ignored: [], elided: [] };

/**
 * What the marketplace offers, marked with what this machine already has. The
 * registry answers with a `Result` and its own progress events, so this is the
 * first action that needs no bridge in front of it.
 */
export class ListAction {
  /**
   * `notify` is required and comes from `ListCommand`: this action renders
   * nothing itself - the command turns its report into a table - so the one
   * thing it does say out loud has to arrive from the class that owns the
   * words rather than be imported here.
   */
  constructor(
    private readonly registry: RegistryClient,
    private readonly notify: MarketplaceListener,
    private readonly pathOpts?: PathOpts,
  ) {}

  readonly execute = async (brand: Brand): Promise<ActionResult<ListReport>> => {
    const empty: ListResult = {
      label: brand.label,
      marketplace: null,
      repo: brand.repo,
      plugins: [],
    };
    const nothing: ListReport = { result: empty, gaps: NO_GAPS };

    const read = await this.registry.readRegistry({
      repo: brand.repo,
      ref: brand.ref,
      notify: this.notify,
    });
    if (!read.ok) return ActionResult.failed(nothing, read.error);
    const catalog = read.value;
    if (!catalog) {
      return ActionResult.failed(
        nothing,
        new Failure(
          `Could not read ${brand.label}.`,
          'Check --repo, or the branch you pointed at with --ref.',
        ),
      );
    }

    // One read for both the installed marks and what the view left out. Reading
    // the file twice was how those two came to be able to disagree.
    const gaps = openManifest(paths.manifestPath(this.pathOpts)).read();
    const targetsByPlugin = new Map(
      gaps.plugins
        .filter((p) => RepoSlug.same(p.repo, brand.repo))
        .map((p): [string, HarnessName[]] => [p.plugin, p.targets]),
    );

    return ActionResult.success({
      gaps,
      result: {
        label: brand.label,
        marketplace: catalog.marketplace,
        repo: brand.repo,
        plugins: catalog.plugins.map((p) => {
          const name = typeof p === 'string' ? p : p.name;
          const targets = targetsByPlugin.get(name) || [];
          return {
            name,
            description:
              typeof p === 'object' && nonEmptyString(p.description) ? p.description : '',
            targets,
            installed: targets.length > 0,
          };
        }),
      },
    });
  };
}
