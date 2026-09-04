import { readRegistry, type RegistryRequest } from './infrastructure/github-registry-client.js';
import { announceMarketplace } from './prompts/marketplace.js';
import type { Catalog, CatalogPluginEntry, ResolvedPlugin } from './types/catalog.js';
import { REGISTRY_FILES } from './types/catalog.js';
import { MarketplaceName } from './types/ids/marketplace-name.js';
import type { Deps } from './types/ports.js';
import { UserError, orThrow, suggest, isPlainObject, nonEmptyString } from './util.js';

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

const nameOf = (p: CatalogPluginEntry): string => (typeof p === 'string' ? p : p.name);

export const entryFor = (
  catalog: Catalog | null,
  plugin: string,
): CatalogPluginEntry | undefined =>
  catalog ? catalog.plugins.find((p) => nameOf(p) === plugin) : undefined;

export function sourcePathFor(entry: CatalogPluginEntry | undefined, plugin: string): string {
  const source: unknown = entry && typeof entry === 'object' ? entry.source : undefined;
  if (typeof source === 'string' && source.trim()) {
    const rel = source.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel && !rel.includes('..')) return rel;
  }
  // Any non-string object, arrays included: the entry points somewhere this tool
  // cannot follow, and guessing plugins/<id> would install the wrong thing.
  if (source !== null && typeof source === 'object') {
    const kind = isPlainObject(source) && nonEmptyString(source.source) ? source.source : 'object';
    throw new UserError(
      `Plugin '${plugin}' is hosted in another repository (source type '${kind}').`,
      { hint: 'Point --repo at the repository that actually contains the plugin folder.' },
    );
  }
  return `plugins/${plugin}`;
}

export interface ResolvePluginOptions {
  repo: string;
  ref: string;
  plugin: string;
  marketplace?: string | null;
  /** What the user sees in place of the repository. */
  label?: string;
  deps?: Deps;
  /** A registry the session already loaded; `null` means the repo has none. */
  catalog?: Catalog | null;
}

export async function resolvePlugin({
  repo,
  ref,
  plugin,
  marketplace = null,
  label,
  deps = {},
  catalog: preloaded,
}: ResolvePluginOptions): Promise<ResolvedPlugin> {
  const shown = label || `${repo}@${ref}`;
  const catalog = preloaded === undefined ? await loadCatalog({ repo, ref, deps }) : preloaded;
  const entry = entryFor(catalog, plugin);

  // Also fires when every declared entry was unusable, so a typo does not walk
  // past this into a late "plugin folder is empty" failure.
  if (catalog && (catalog.plugins.length || catalog.dropped) && !entry) {
    const known = catalog.plugins.map(nameOf);
    const close = suggest(plugin, known);
    const declared = catalog.dropped === 1 ? 'one entry' : `${catalog.dropped} entries`;
    throw new UserError(`Plugin '${plugin}' is not listed in ${shown}.`, {
      hint: close.length
        ? `Did you mean: ${close.join(', ')}?  Run 'list' to see all ${known.length}.`
        : known.length
          ? `Run 'list' to see the ${known.length} available plugins.`
          : `The registry declares ${declared}, but none has a usable string 'name'.`,
    });
  }

  const resolvedMarketplace = marketplace || catalog?.marketplace;
  if (!resolvedMarketplace) {
    throw new UserError(`Could not determine the marketplace name for ${shown}.`, {
      hint: `No 'name' in ${REGISTRY_FILES[0]}. Pass --marketplace <name>.`,
    });
  }

  // Otherwise the failure surfaces later as a bare "plugin not found" from claude.
  if (!MarketplaceName.create(resolvedMarketplace)) {
    throw new UserError(`Marketplace name '${resolvedMarketplace}' is not a valid identifier.`, {
      hint: `It must be ${MarketplaceName.RULE} (e.g. my-marketplace). Fix 'name' in ${REGISTRY_FILES[0]}.`,
    });
  }

  return {
    plugin,
    repo,
    ref,
    marketplace: resolvedMarketplace,
    sourcePath: sourcePathFor(entry, plugin),
    description: isPlainObject(entry) && nonEmptyString(entry.description) ? entry.description : '',
    catalogFound: Boolean(catalog),
  };
}
