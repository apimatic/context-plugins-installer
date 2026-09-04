// A marketplace registry as this build reads it, and one plugin resolved out of
// it. Runtime code validates the JSON these describe; the types describe the
// already-validated result.

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
