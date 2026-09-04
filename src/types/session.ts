import type { Catalog } from './catalog.js';

// Work shared by every plugin in one run: the registry read, the clone, the
// Claude marketplace registration, each done once per repo and ref.

export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  checkout(sourcePath: string): Promise<string>;
}

export interface Session {
  marketplaces: Map<string, Promise<{ known: string; updated: boolean }>>;
  catalog(args: { repo: string; ref: string }): Promise<Catalog | null>;
  source(args: { repo: string; ref: string; sourcePath: string }): Promise<string | null>;
  cleanup(): Promise<void>;
}
