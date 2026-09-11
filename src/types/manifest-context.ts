import { Failure } from './failure.js';
import { NAMES, type HarnessName } from './harness.js';
import { RepoSlug } from './ids/repo-slug.js';
import {
  foldRows,
  foreignTargets,
  manifestView,
  matchesKey,
  sanitizeEntry,
  type EntryKey,
  type Manifest,
  type ManifestEntry,
} from './installed-record.js';
import { isPlainObject } from './util.js';
import { isLocalKey } from './plugin-source.js';
import type { ManifestStore } from './ports.js';
import type { UninstallDecision } from './uninstall.js';

// `~/.context-plugins/installed.json` as a domain object: the read view, the
// lookups, and the only two writes this program makes. It takes a store rather
// than a path, so it knows nothing about files.
//
// The rule the type exists to enforce: a row is never written back from the
// sanitized read view. Both writers rebuild from the raw row, so a field or a
// target name belonging to a newer CLI survives a rewrite - and because the
// rebuild and the read it rebuilds from are one operation here, there is no
// longer a way for a caller to get that pairing wrong.

/** What an install has to record, once it knows what it installed. */
export interface InstallRecord {
  plugin: string;
  repo: string;
  marketplace: string;
  /** Null for a source with no version to record: a directory on this machine. */
  ref: string | null;
  /** Editors this run installed into. */
  installed: readonly HarnessName[];
  /**
   * Editors an earlier run installed into that this run skipped. Their copies
   * are still on disk, so they stay on the record or `update` would never
   * refresh them.
   */
  untouched: readonly HarnessName[];
}

export class ManifestContext {
  /** `now` is required: a clock default here would put nondeterminism in types/. */
  constructor(
    private readonly store: ManifestStore,
    private readonly now: () => string,
  ) {}

  /**
   * The rows a key matches, as one row. There can be several - see `foldRows` -
   * and reading only the first is how a decision came to be written onto a row
   * it had never seen.
   */
  private rowFor(key: EntryKey): Record<string, unknown> | null {
    return foldRows(this.store.findAllRaw(key));
  }

  read(): Manifest {
    return manifestView(this.store.readRaw());
  }

  list(): ManifestEntry[] {
    return this.read().plugins;
  }

  find({ plugin, repo }: EntryKey): ManifestEntry | null {
    // Without a repo the key spans marketplaces, so those rows are different
    // plugins that share an id and must not be folded together.
    if (!repo) return this.list().find((p) => p.plugin === plugin) || null;
    return sanitizeEntry(this.rowFor({ plugin, repo }));
  }

  /** The raw row, shape unchecked, for entries the sanitized view hides. */
  findRaw(key: EntryKey): Record<string, unknown> | null {
    return this.rowFor(key);
  }

  /**
   * The row an argument names and the key that writes it, in one read.
   *
   * A plugin installed from a directory is keyed by that directory, and an id
   * is what a user types to remove one - so when the configured key matches
   * nothing, a row for the same id from a path is what they meant. The
   * configured key is tried first, so nothing about the spelling this program
   * has always taken changes.
   *
   * Over the raw rows, not the read view: a row the view hides is exactly the
   * one this has to reach. `['cursor','zed']` shortened by an earlier
   * uninstall to `['zed']` is dropped from the view, and looking there would
   * strand it - unremovable, and failing every `update`.
   */
  locate(plugin: string, repo: string): { key: EntryKey; row: Record<string, unknown> | null } {
    const rows = this.store.readRaw().plugins;
    const configured: EntryKey = { plugin, repo };
    const matching = rows.filter((r): r is Record<string, unknown> => matchesKey(r, configured));
    if (matching.length) return { key: configured, row: foldRows(matching) };

    const local = rows.find(
      (r): r is Record<string, unknown> =>
        isPlainObject(r) && r.plugin === plugin && isLocalKey(r.repo),
    );
    if (!local) return { key: configured, row: null };
    const key: EntryKey = { plugin, repo: local.repo };
    const found = rows.filter((r): r is Record<string, unknown> => matchesKey(r, key));
    return { key, row: foldRows(found) };
  }

  /**
   * Cursor and VS Code both keep plugins in a flat `<plugin>/` directory, so the
   * same id from a second source - another marketplace, or a folder on this
   * machine - would silently overwrite the first. `--force` is the caller's to
   * honour: this only reports the clash.
   */
  conflictFor({ plugin, repo }: { plugin: string; repo: string }): Failure | null {
    const clash = this.list().find((p) => p.plugin === plugin && !RepoSlug.same(p.repo, repo));
    if (!clash) return null;
    return new Failure(
      `'${plugin}' is already installed from a different source.`,
      'Uninstall it first, or re-run with --force to replace it.',
    );
  }

  recordInstall({ plugin, repo, marketplace, ref, installed, untouched }: InstallRecord): void {
    const raw = this.rowFor({ plugin, repo });
    const keep = new Set<HarnessName>([...untouched, ...installed]);
    this.store.upsert({
      ...raw, // unknown fields ride along untouched
      plugin,
      repo,
      marketplace,
      // Omitted rather than written empty when there is none: `sanitizeEntry`
      // reads an empty string as absent anyway, so writing one would put a key
      // on disk that no reader can tell from a missing one.
      ...(ref === null ? {} : { ref }),
      targets: [
        ...NAMES.filter((n) => keep.has(n)), // canonical order
        ...foreignTargets(raw),
      ],
      installedAt: this.now(),
    });
  }

  applyUninstall(key: EntryKey, decision: UninstallDecision): void {
    if (decision.write === 'remove') {
      this.store.remove(key);
      return;
    }
    if (decision.write !== 'shorten') return;
    const raw = this.rowFor(key);
    if (raw) this.store.upsert({ ...raw, targets: decision.targets });
  }
}
