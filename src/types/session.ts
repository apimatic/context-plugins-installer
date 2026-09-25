import type { Catalog } from './catalog.js';
import type { Failure } from './failure.js';
import type { DirectoryPath } from './file/paths.js';
import type { PluginManifest } from './plugin-manifest.js';
import type { ArchiveAt } from './plugin-source.js';
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
  | { kind: 'downloaded'; files: number }
  | { kind: 'downloading'; url: string }
  | { kind: 'unpacked'; files: number; bytes: number }
  | { kind: 'entry-skipped'; names: readonly string[]; count: number };

export type MarketplaceListener = (event: MarketplaceEvent) => void;

export interface RepoHandle {
  via: 'git' | 'api';
  cleanup(): void;
  /** `null` is the repository itself, for a repo that is a plugin rather than a marketplace. */
  checkout(sourcePath: string | null): Promise<Result<DirectoryPath, Failure>>;
}

/**
 * One archive, downloaded (or opened where it lies) and unpacked into a
 * workspace of its own. Shaped like `RepoHandle` for the same reason, and with
 * the same split: the download is per archive and the extraction per folder, so
 * two plugins out of one monorepo archive cost one of the first and two of the
 * second.
 */
export interface ArchiveHandle {
  cleanup(): void;
  /** A folder inside the archive, or `null` for whatever it wraps. */
  files(inside: string | null): Promise<Result<DirectoryPath, Failure>>;
}

export interface ArchiveRequest {
  at: ArchiveAt;
  /** The folder inside the archive, or null for whatever it wraps. */
  path: string | null;
  /** How the user named it, which is what every failure below here says back. */
  describe: string;
}

export interface Session {
  /**
   * Which marketplace name Claude Code filed a repository under, per session.
   * A `Result`, because a registration that cannot be made is the user's to fix
   * and every plugin from that marketplace shares the one answer.
   */
  marketplaces: Map<string, Promise<Result<{ known: string; updated: boolean }, Failure>>>;
  /**
   * The same for Codex, in a map of its own: each CLI files a marketplace under
   * a name of its own, and Codex has one more answer - `unsupported`, for a
   * Codex too old to have a `plugin` command - which every plugin in the run
   * shares too, so it is asked once rather than refused once per plugin.
   */
  codexMarketplaces: Map<
    string,
    Promise<Result<{ known: string; updated: boolean } | 'unsupported', Failure>>
  >;
  catalog(args: { repo: string; ref: string }): Promise<Result<Catalog | null, Failure>>;
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
  /** One download per archive in a run, however many plugins come out of it. */
  archive(args: ArchiveRequest): Promise<Result<DirectoryPath, Failure>>;
  cleanup(): Promise<void>;
}
