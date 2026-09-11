import type { Catalog } from './catalog.js';
import type { Failure } from './failure.js';
import type { DirectoryPath } from './file/paths.js';
import type { PluginManifest } from './plugin-manifest.js';
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
  | { kind: 'raw-outage'; host: string; status: number }
  | { kind: 'no-git' }
  | { kind: 'cloning'; url: string; ref: string }
  | { kind: 'checked-out'; files: number }
  | { kind: 'tree-truncated' }
  | { kind: 'downloaded'; files: number };

export type MarketplaceListener = (event: MarketplaceEvent) => void;

export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  /** `null` is the repository itself, for a repo that is a plugin rather than a marketplace. */
  checkout(sourcePath: string | null): Promise<Result<DirectoryPath, Failure>>;
}

export interface Session {
  /**
   * Which marketplace name Claude Code filed a repository under, per session.
   * A `Result`, because a registration that cannot be made is the user's to fix
   * and every plugin from that marketplace shares the one answer.
   */
  marketplaces: Map<string, Promise<Result<{ known: string; updated: boolean }, Failure>>>;
  catalog(args: { repo: string; ref: string }): Promise<Result<Catalog | null, Failure>>;
  /**
   * The manifest of a repository that is itself a plugin, beside `catalog` for
   * the reason that is here: it is a read of one repository at one ref, and a
   * run may want it more than once.
   */
  manifest(args: {
    repo: string;
    ref: string;
    path: string | null;
  }): Promise<Result<PluginManifest, Failure>>;
  source(args: {
    repo: string;
    ref: string;
    /** `null` is the repository itself; a path is a folder inside it. */
    sourcePath: string | null;
  }): Promise<Result<DirectoryPath, Failure>>;
  cleanup(): Promise<void>;
}
