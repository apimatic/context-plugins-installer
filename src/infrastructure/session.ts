import type { Catalog } from '../types/catalog.js';
import type { Failure } from '../types/failure.js';
import type { Deps } from '../types/ports.js';
import { ok, type Result } from '../types/result.js';
import type { MarketplaceListener, RepoHandle, Session } from '../types/session.js';
import { readRegistry } from './github-registry-client.js';
import { openRepo } from './source-fetcher.js';

const keyOf = (repo: string, ref: string): string => `${repo}@${ref}`;

// Work shared by every plugin in one run - registry, clone, Claude marketplace
// registration - each done once per repo@ref. Promises are cached rather than
// results so concurrent callers share one request.
export function createSession({
  deps = {},
  notify,
}: { deps?: Deps; notify?: MarketplaceListener } = {}): Session {
  const catalogs = new Map<string, Promise<Result<Catalog | null, Failure>>>();
  const repos = new Map<string, Promise<RepoHandle>>();
  const marketplaces: Session['marketplaces'] = new Map();
  const disposers: (() => void)[] = [];

  return {
    marketplaces,

    catalog({ repo, ref }) {
      const key = keyOf(repo, ref);
      let pending = catalogs.get(key);
      if (!pending) {
        pending = readRegistry({ repo, ref, deps, notify });
        catalogs.set(key, pending);
      }
      return pending;
    },

    async source({ repo, ref, sourcePath }): Promise<Result<string | null, Failure>> {
      // An injected fetch is the test seam and stays per-plugin. It is the one
      // path that can still throw: a fake that blows up is a test asserting a
      // bug, not a failure this program knows how to describe.
      if (deps.materialize) {
        const result = await deps.materialize({ repo, ref, sourcePath, deps });
        if (result && typeof result.cleanup === 'function') disposers.push(result.cleanup);
        return ok(result ? result.dir : null);
      }

      const key = keyOf(repo, ref);
      let opening = repos.get(key);
      if (!opening) {
        opening = openRepo({ repo, ref, deps, notify });
        repos.set(key, opening);
      }
      const handle = await opening;
      return handle.checkout(sourcePath);
    },

    async cleanup() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          /* best effort */
        }
      }
      const pending = [...repos.values()];
      repos.clear();
      for (const opening of pending) {
        try {
          (await opening).cleanup();
        } catch {
          /* never opened, or a locked temp dir */
        }
      }
    },
  };
}
