'use strict';

const { loadCatalog } = require('./catalog');
const { openRepo } = require('./fetch');

const keyOf = (repo, ref) => `${repo}@${ref}`;

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
function createSession({ deps = {} } = {}) {
  const catalogs = new Map();
  const repos = new Map();
  const marketplaces = new Map();
  const vias = new Map();
  const disposers = [];

  return {
    /** Claude Code marketplace registrations, memoized by the harness. */
    marketplaces,

    /** The marketplace registry for a repo@ref. Fetched at most once. */
    catalog({ repo, ref }) {
      const key = keyOf(repo, ref);
      // Cache the promise so concurrent callers share the one request.
      if (!catalogs.has(key)) catalogs.set(key, loadCatalog({ repo, ref, deps }));
      return catalogs.get(key);
    },

    /** A directory holding one plugin's files. Returns the path. */
    async source({ repo, ref, sourcePath }) {
      // An injected fetch is the test seam and stays per-plugin.
      if (deps.materialize) {
        const result = await deps.materialize({ repo, ref, sourcePath, deps });
        if (result && typeof result.cleanup === 'function') disposers.push(result.cleanup);
        if (result && result.via) vias.set(keyOf(repo, ref), result.via);
        return result ? result.dir : null;
      }

      const key = keyOf(repo, ref);
      if (!repos.has(key)) repos.set(key, openRepo({ repo, ref, deps }));
      const handle = await repos.get(key);
      vias.set(key, handle.via);
      return handle.checkout(sourcePath);
    },

    /**
     * How this repo's files arrived - 'git' or 'api' - or null before anything
     * was fetched. Which path a machine takes is the difference between a clone
     * and 60 API requests an hour, so it is worth being able to report.
     */
    via({ repo, ref }) {
      return vias.get(keyOf(repo, ref)) || null;
    },

    /** Drop every temp directory the run opened. Safe to call more than once. */
    async cleanup() {
      while (disposers.length) {
        try {
          disposers.pop()();
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

module.exports = { createSession };
