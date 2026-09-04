import type { Catalog } from './catalog.js';
import type { Failure } from './failure.js';
import type { Result } from './result.js';

// Work shared by every plugin in one run: the registry read, the clone, the
// Claude marketplace registration, each done once per repo and ref.

/**
 * What reading a marketplace does, as facts rather than sentences: the registry
 * files it could not read, and how it got the plugin's files. A prompts class
 * turns each into the line it has always been, which is what lets infrastructure
 * stay silent without moving where that line appears - a warning that git is
 * missing is only useful before the slow fallback it explains, not after.
 *
 * Being an event rather than a field on the result also means the memo decides
 * how often it is said. Both clients are called through a session that caches
 * the promise, so the work and the words happen together: once per run.
 */
export type MarketplaceEvent =
  | { kind: 'registry-skipped'; file: string; repo: string }
  | { kind: 'no-git' }
  | { kind: 'cloning'; url: string; ref: string }
  | { kind: 'checked-out'; files: number }
  | { kind: 'tree-truncated' }
  | { kind: 'downloaded'; files: number };

export type MarketplaceListener = (event: MarketplaceEvent) => void;

export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  checkout(sourcePath: string): Promise<Result<string, Failure>>;
}

export interface Session {
  marketplaces: Map<string, Promise<{ known: string; updated: boolean }>>;
  catalog(args: { repo: string; ref: string }): Promise<Result<Catalog | null, Failure>>;
  source(args: {
    repo: string;
    ref: string;
    sourcePath: string;
  }): Promise<Result<string | null, Failure>>;
  cleanup(): Promise<void>;
}
