import { loadCatalog } from './catalog.js';
import { openRepo } from './fetch.js';
import type { Catalog, Deps, RepoHandle, Session } from './types.js';

const keyOf = (repo: string, ref: string): string => `${repo}@${ref}`;

/**
 * Work that is shared by every plugin in one command.
 *
 * `update` re-installs each recorded plugin in turn, and on its own each of
 * those would re-read the registry, re-clone the whole marketplace, and
 * re-register it with Claude Code - identical work every time, so the run cost
 * scaled with the number of installed plugins *and* with the size of the
 * marketplace. A session does each of those once and hands the result around.
 *
 * Everything is keyed by repo@ref, because manifest entries each record their
 * own and an update may legitimately span more than one marketplace.
 *
 * `install` builds a throwaway session so the single-plugin path is unchanged.
 */
export function createSession({ deps = {} }: { deps?: Deps } = {}): Session {
  const catalogs = new Map<string, Promise<Catalog | null>>();
  const repos = new Map<string, Promise<RepoHandle>>();
  const marketplaces: Session['marketplaces'] = new Map();
  const disposers: (() => void)[] = [];

  return {
    /** Claude Code marketplace registrations, memoized by the harness. */
    marketplaces,

    /** The marketplace registry for a repo@ref. Fetched at most once. */
    catalog({ repo, ref }) {
      const key = keyOf(repo, ref);
      // Cache the promise so concurrent callers share the one request.
      let pending = catalogs.get(key);
      if (!pending) {
        pending = loadCatalog({ repo, ref, deps });
        catalogs.set(key, pending);
      }
      return pending;
    },

    /** A directory holding one plugin's files. Returns the path. */
    async source({ repo, ref, sourcePath }) {
      // An injected fetch is the test seam and stays per-plugin.
      if (deps.materialize) {
        const result = await deps.materialize({ repo, ref, sourcePath, deps });
        if (result && typeof result.cleanup === 'function') disposers.push(result.cleanup);
        return result ? result.dir : null;
      }

      const key = keyOf(repo, ref);
      let opening = repos.get(key);
      if (!opening) {
        opening = openRepo({ repo, ref, deps });
        repos.set(key, opening);
      }
      const handle = await opening;
      return handle.checkout(sourcePath);
    },

    /** Drop every temp directory the run opened. Safe to call more than once. */
    async cleanup() {
      // Last opened, first disposed - the order they were pushed, reversed.
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
          /* the repo never opened, or its temp dir is locked - neither is fatal */
        }
      }
    },
  };
}
