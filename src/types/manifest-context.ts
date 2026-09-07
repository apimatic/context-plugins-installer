import { Failure } from './failure.js';
import { NAMES, type HarnessName } from './harness.js';
import {
  foreignTargets,
  manifestView,
  sameEntry,
  type EntryKey,
  type Manifest,
  type ManifestEntry,
} from './installed-record.js';
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
  ref: string;
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
  constructor(
    private readonly store: ManifestStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  read(): Manifest {
    return manifestView(this.store.readRaw());
  }

  list(): ManifestEntry[] {
    return this.read().plugins;
  }

  find({ plugin, repo }: EntryKey): ManifestEntry | null {
    return (
      this.list().find((p) => (repo ? sameEntry(p, { plugin, repo }) : p.plugin === plugin)) || null
    );
  }

  /** The raw row, shape unchecked, for entries the sanitized view hides. */
  findRaw(key: EntryKey): Record<string, unknown> | null {
    return this.store.findRaw(key);
  }

  /**
   * Cursor and VS Code both keep plugins in a flat `<plugin>/` directory, so the
   * same id from a second marketplace would silently overwrite the first.
   * `--force` is the caller's to honour: this only reports the clash.
   */
  conflictFor({ plugin, repo }: { plugin: string; repo: string }): Failure | null {
    const clash = this.list().find((p) => p.plugin === plugin && (p.repo || '') !== repo);
    if (!clash) return null;
    return new Failure(
      `'${plugin}' is already installed from a different marketplace.`,
      'Uninstall it first, or re-run with --force to replace it.',
    );
  }

  recordInstall({ plugin, repo, marketplace, ref, installed, untouched }: InstallRecord): void {
    const raw = this.store.findRaw({ plugin, repo });
    const keep = new Set<HarnessName>([...untouched, ...installed]);
    this.store.upsert({
      ...raw, // unknown fields ride along untouched
      plugin,
      repo,
      marketplace,
      ref,
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
    const raw = this.store.findRaw(key);
    if (raw) this.store.upsert({ ...raw, targets: decision.targets });
  }
}
