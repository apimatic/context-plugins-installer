import type { Catalog } from '../types/catalog.js';
import type { Failure } from '../types/failure.js';
import type { DirectoryPath } from '../types/file/paths.js';
import type { PluginManifest } from '../types/plugin-manifest.js';
import type { RegistryClient, SourceFetcher } from '../types/ports.js';
import type { Result } from '../types/result.js';
import type { ArchiveHandle, MarketplaceListener, RepoHandle, Session } from '../types/session.js';

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
  const manifests = new Map<string, Promise<Result<PluginManifest, Failure>>>();
  const repos = new Map<string, Promise<RepoHandle>>();
  const archives = new Map<string, ArchiveHandle>();
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

    manifest({ repo, ref, path }) {
      // JSON rather than joined: a ref and a folder can both hold a slash.
      const key = JSON.stringify([repo.toLowerCase(), ref, path]);
      let pending = manifests.get(key);
      if (!pending) {
        pending = registry.readPluginManifest({ repo, ref, path, notify });
        manifests.set(key, pending);
      }
      return pending;
    },

    async source({ repo, ref, sourcePath }): Promise<Result<DirectoryPath, Failure>> {
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

    archive({ at, path, describe }) {
      // The archive alone, not the folder inside it: the download is shared by
      // every plugin that comes out of one, the way a clone is.
      const key = JSON.stringify([at.kind, at.kind === 'url' ? at.url : at.file.toString()]);
      let handle = archives.get(key);
      if (!handle) {
        handle = fetcher.openArchive({ at, describe, notify });
        archives.set(key, handle);
      }
      return handle.files(path);
    },

    async cleanup() {
      const opened = [...archives.values()];
      archives.clear();
      for (const handle of opened) {
        try {
          handle.cleanup();
        } catch {
          /* a locked workspace outliving the run is the lesser problem */
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
