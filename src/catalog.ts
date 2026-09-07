import { readRegistry, type RegistryRequest } from './infrastructure/github-registry-client.js';
import { announceMarketplace } from './prompts/marketplace.js';
import type { Catalog } from './types/catalog.js';
import { orThrow } from './util.js';

/**
 * The bridge in front of the registry client: the client answers with a Result
 * and a listener, and this throws the way its callers still expect. Phase 5
 * gives the Result to the actions and the bridge goes.
 */
export async function loadCatalog({
  repo,
  ref,
  deps = {},
}: RegistryRequest): Promise<Catalog | null> {
  return orThrow(await readRegistry({ repo, ref, deps, notify: announceMarketplace }));
}
