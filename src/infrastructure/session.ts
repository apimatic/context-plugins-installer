import type { Catalog } from '../types/catalog.js';
import type { Failure } from '../types/failure.js';
import type { DirectoryPath } from '../types/file/paths.js';
import type { RegistryClient, SourceFetcher } from '../types/ports.js';
import type { Result } from '../types/result.js';
import type { MarketplaceListener, RepoHandle, Session } from '../types/session.js';

// Case-folded on the repo half, the way GitHub reads a slug: two rows spelled
// `Acme/M` and `acme/m` are one repository, and keying on the spelling made one
// `update` clone it twice and say so twice - which is the opposite of what this
// memo exists for.
const keyOf = (repo: string, ref: string): string => `${repo.toLowerCase()}@${ref}`;

// Work shared by every plugin in one run - registry, clone, Claude marketplace
// registration - each done once per repo@ref. Promises are cached rather than
// results so concurrent callers share one request.
export function createSession({
  registry,
  fetcher,
  notify,
}: {
  registry: RegistryClient;
  fetcher: SourceFetcher;
  notify?: MarketplaceListener;
}): Session {
  const catalogs = new Map<string, Promise<Result<Catalog | null, Failure>>>();
  const repos = new Map<string, Promise<RepoHandle>>();
  const marketplaces: Session['marketplaces'] = new Map();

  return {
    marketplaces,

    catalog({ repo, ref }) {
      const key = keyOf(repo, ref);
      let pending = catalogs.get(key);
      if (!pending) {
        pending = registry.readRegistry({ repo, ref, notify });
        catalogs.set(key, pending);
      }
      return pending;
    },

    async source({ repo, ref, sourcePath }): Promise<Result<DirectoryPath | null, Failure>> {
      // One handle per repo@ref, and every checkout after the first is local.
      // A test substitutes the whole fetcher rather than an injected hook,
      // which is what let this method stop having two shapes.
      const key = keyOf(repo, ref);
      let opening = repos.get(key);
      if (!opening) {
        opening = fetcher.openRepo({ repo, ref, notify });
        repos.set(key, opening);
      }
      const handle = await opening;
      return handle.checkout(sourcePath);
    },

    async cleanup() {
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
