import test from 'node:test';
import assert from 'node:assert';

import { loadCatalog } from '../src/catalog.js';
import { rawUrl } from '../src/infrastructure/github-registry-client.js';
import type { Deps } from '../src/types/ports.js';
import { UserError } from '../src/util.js';
import { stubFetch, type StubRoute } from './helpers.js';

const REPO = 'context-plugins/plugin-marketplace';
const CLAUDE_REG = rawUrl(REPO, 'main', '.claude-plugin/marketplace.json');

const deps = (routes: Record<string, StubRoute>): Deps => ({
  fetchImpl: stubFetch(routes),
  env: {},
});

// All that is left of this module is the bridge. The registry client returns a
// Failure and the resolution is pure; this is the throw every caller still
// expects, message and hint intact. Both go in Phase 5 with `orThrow`.
test('a failure from the registry client reaches callers as a UserError', async () => {
  await assert.rejects(
    loadCatalog({ repo: REPO, ref: 'main', deps: deps({ [CLAUDE_REG]: { status: 403 } }) }),
    (err) => err instanceof UserError && /GITHUB_TOKEN/.test(err.hint ?? ''),
  );
});

test('a repo with no registry file at all reads as no catalog, not an error', async () => {
  assert.equal(await loadCatalog({ repo: REPO, ref: 'main', deps: deps({}) }), null);
});
