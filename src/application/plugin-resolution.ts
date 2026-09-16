import type { Catalog, CatalogPluginEntry, ResolvedPlugin } from '../types/catalog.js';
import { REGISTRY_FILES } from '../types/catalog.js';
import { Failure } from '../types/failure.js';
import { MarketplaceName } from '../types/ids/marketplace-name.js';
import { RepoMarketplace } from '../types/marketplace-origin.js';
import { err, ok, type Result } from '../types/result.js';
import { isPlainObject, nonEmptyString } from '../types/util.js';

// Which plugin a run is about, decided from the registry it was given. Pure: the
// catalog arrives already read, `null` meaning the repo declares none, and every
// way this can go wrong comes back as a Failure rather than a throw.

const nameOf = (p: CatalogPluginEntry): string => (typeof p === 'string' ? p : p.name);

const entryFor = (catalog: Catalog | null, plugin: string): CatalogPluginEntry | undefined =>
  catalog ? catalog.plugins.find((p) => nameOf(p) === plugin) : undefined;

export function sourcePathFor(
  entry: CatalogPluginEntry | undefined,
  plugin: string,
): Result<string, Failure> {
  const source: unknown = entry && typeof entry === 'object' ? entry.source : undefined;
  if (typeof source === 'string' && source.trim()) {
    const rel = source.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel && !rel.includes('..')) return ok(rel);
  }
  // Any non-string object, arrays included: the entry points somewhere this tool
  // cannot follow, and guessing plugins/<id> would install the wrong thing.
  if (source !== null && typeof source === 'object') {
    const kind = isPlainObject(source) && nonEmptyString(source.source) ? source.source : 'object';
    return err(
      new Failure(
        `Plugin '${plugin}' is hosted in another repository (source type '${kind}').`,
        'Point --repo at the repository that actually contains the plugin folder.',
      ),
    );
  }
  return ok(`plugins/${plugin}`);
}

export interface ResolveRequest {
  plugin: string;
  repo: string;
  ref: string;
  /** An explicit `--marketplace`, which wins over the registry's own name. */
  marketplace?: string | null;
  /** What the user sees in place of the repository. */
  label?: string;
}

export function resolvePlugin(
  catalog: Catalog | null,
  { plugin, repo, ref, marketplace = null, label }: ResolveRequest,
): Result<ResolvedPlugin, Failure> {
  const shown = label || `${repo}@${ref}`;
  const entry = entryFor(catalog, plugin);

  // Also fires when every declared entry was unusable, so a typo does not walk
  // past this into a late "plugin folder is empty" failure.
  if (catalog && (catalog.plugins.length || catalog.dropped) && !entry) {
    const known = catalog.plugins.map(nameOf);
    const close = suggest(plugin, known);
    const declared = catalog.dropped === 1 ? 'one entry' : `${catalog.dropped} entries`;
    return err(
      new Failure(
        `Plugin '${plugin}' is not listed in ${shown}.`,
        close.length
          ? `Did you mean: ${close.join(', ')}?  Run 'list' to see all ${known.length}.`
          : known.length
            ? `Run 'list' to see the ${known.length} available plugins.`
            : `The registry declares ${declared}, but none has a usable string 'name'.`,
      ),
    );
  }

  const resolvedMarketplace = marketplace || catalog?.marketplace;
  if (!resolvedMarketplace) {
    return err(
      new Failure(
        `Could not determine the marketplace name for ${shown}.`,
        `No 'name' in ${REGISTRY_FILES[0]}. Pass --marketplace <name>.`,
      ),
    );
  }

  // Otherwise the failure surfaces later as a bare "plugin not found" from claude.
  const name = MarketplaceName.create(resolvedMarketplace);
  if (!name) {
    return err(
      new Failure(
        `Marketplace name '${resolvedMarketplace}' is not a valid identifier.`,
        `It must be ${MarketplaceName.RULE} (e.g. my-marketplace). Fix 'name' in ${REGISTRY_FILES[0]}.`,
      ),
    );
  }

  const sourcePath = sourcePathFor(entry, plugin);
  if (!sourcePath.ok) return err(sourcePath.error);

  return ok({
    plugin,
    origin: RepoMarketplace.named(repo, name),
    ref,
    sourcePath: sourcePath.value,
    description: isPlainObject(entry) && nonEmptyString(entry.description) ? entry.description : '',
    catalogFound: Boolean(catalog),
  });
}

export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev: number[] = Array.from({ length: cols }, (_v, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j < cols; j += 1) {
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1] as number;
}

const sharedPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

// Substring and shared-prefix hits rank before edit distance: plugin ids share
// suffixes like `-sdk`, which makes a near miss look far away.
export function suggest(query: string, candidates: readonly string[], limit = 3): string[] {
  const q = String(query).toLowerCase();
  const threshold = Math.max(3, Math.ceil(q.length * 0.4));
  const scored = candidates
    .map((name) => {
      const n = String(name).toLowerCase();
      if (n.includes(q) || q.includes(n)) return { name, score: 0 };
      if (sharedPrefix(q, n) >= Math.max(4, Math.ceil(q.length * 0.6))) return { name, score: 1 };
      return { name, score: editDistance(q, n) };
    })
    .filter((c) => c.score <= threshold)
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map((c) => c.name);
}
