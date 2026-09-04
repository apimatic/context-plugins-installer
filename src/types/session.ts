import type { RegistryRead } from './catalog.js';
import type { Failure } from './failure.js';
import type { Result } from './result.js';

// Work shared by every plugin in one run: the registry read, the clone, the
// Claude marketplace registration, each done once per repo and ref.

/**
 * What fetching a plugin's source does, as facts rather than sentences. The
 * fetcher emits one the moment it happens and a prompts class turns it into the
 * line it has always been, which is what lets infrastructure stay silent without
 * moving where that line appears: a warning that git is missing is only useful
 * before the slow fallback it explains, not after.
 */
export type SourceEvent =
  | { kind: 'no-git' }
  | { kind: 'cloning'; url: string; ref: string }
  | { kind: 'checked-out'; files: number }
  | { kind: 'tree-truncated' }
  | { kind: 'downloaded'; files: number };

export type SourceListener = (event: SourceEvent) => void;

export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  checkout(sourcePath: string): Promise<Result<string, Failure>>;
}

export interface Session {
  marketplaces: Map<string, Promise<{ known: string; updated: boolean }>>;
  catalog(args: { repo: string; ref: string }): Promise<RegistryRead>;
  source(args: {
    repo: string;
    ref: string;
    sourcePath: string;
  }): Promise<Result<string | null, Failure>>;
  cleanup(): Promise<void>;
}
