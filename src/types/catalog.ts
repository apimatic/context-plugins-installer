import type { Failure } from './failure.js';
import type { Result } from './result.js';
import { isPlainObject, nonEmptyString } from '../util.js';

// A marketplace registry as this build reads it, and one plugin resolved out of
// it. The reader in infrastructure fetches the bytes; `normalize` below is the
// one place raw JSON becomes a `Catalog`, so nothing else has to decide what a
// usable entry is.

/** Only `name` is checked on read; other fields are read through type checks. */
export interface CatalogPluginDetails {
  name: string;
  [key: string]: unknown;
}

export type CatalogPluginEntry = string | CatalogPluginDetails;

export interface Catalog {
  marketplace: string | null;
  plugins: CatalogPluginEntry[];
  /** Declared entries that had no usable name. */
  dropped: number;
  from: string;
}

export interface ResolvedPlugin {
  plugin: string;
  repo: string;
  ref: string;
  marketplace: string;
  sourcePath: string;
  description: string;
  catalogFound: boolean;
}

// Claude Code and Cursor read the same registry shape from different folders.
export const REGISTRY_FILES = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
];

const usableEntry = (p: unknown): p is CatalogPluginEntry =>
  nonEmptyString(p) || (isPlainObject(p) && nonEmptyString(p.name));

export function normalize(data: Record<string, unknown>, from: string): Catalog {
  const declared: unknown[] = Array.isArray(data.plugins) ? data.plugins : [];
  const plugins = declared.filter(usableEntry);
  return {
    marketplace: nonEmptyString(data.name) ? data.name : null,
    plugins,
    dropped: declared.length - plugins.length,
    from,
  };
}

/**
 * A registry read: the catalog, or the reason there is none, plus the registry
 * files that were present but not a JSON object. `skipped` rides on the failure
 * arm as well as the success one - a file skipped before a later file failed is
 * still something `--verbose` promised to mention, and a result that only spoke
 * on success would have swallowed it.
 */
export type RegistryRead = Result<Catalog | null, Failure> & {
  readonly skipped: readonly string[];
};
