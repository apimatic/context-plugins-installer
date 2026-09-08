import { readRegistry } from '../infrastructure/github-registry-client.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import { announceMarketplace } from '../prompts/marketplace.js';
import type { Brand } from '../types/brand.js';
import type { PathOpts } from '../types/env.js';
import { Failure } from '../types/failure.js';
import type { HarnessName } from '../types/harness.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type { Manifest } from '../types/installed-record.js';
import type { Deps } from '../types/ports.js';
import type { ListReport, ListResult } from '../types/reports.js';
import { nonEmptyString } from '../types/util.js';
import { ActionResult } from './action-result.js';

export interface ListRequest {
  brand: Brand;
  deps?: Deps;
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
  constructor(
    private readonly deps: Deps = {},
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

    const read = await readRegistry({
      repo: brand.repo,
      ref: brand.ref,
      deps: this.deps,
      notify: announceMarketplace,
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
