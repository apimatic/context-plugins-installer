import type { CodexPlugin, MarketplaceListing } from '../types/harness.js';
import type { ProcessRunner, RunCommand, RunResult } from '../types/ports.js';
import { isPlainObject, nonEmptyString, stripBom } from '../types/util.js';

/** null when the CLI is not on PATH, which every caller reads as "cannot ask". */
export const findCodex = (runner: ProcessRunner): string | null => runner.which('codex');

/**
 * Everything this program says to the `codex` binary, and the only place its
 * argv is spelled. Same split as `claude-cli.ts`: the listings are the
 * validated boundary and answer `null` for "the CLI could not answer", the
 * commands answer with the process result for the harness to interpret.
 *
 * Measured against codex-cli 0.149.1 and 0.156.1, whose `--json` listings are
 * `{ marketplaces: [...] }` and `{ installed: [...], available: [...] }`.
 */
export interface CodexCli {
  listMarketplaces(): Promise<MarketplaceListing[] | null>;
  listPlugins(): Promise<CodexPlugin[] | null>;
  marketplaceAdd(source: string): Promise<RunResult>;
  marketplaceUpgrade(name: string): Promise<RunResult>;
  marketplaceRemove(name: string): Promise<RunResult>;
  pluginAdd(target: string): Promise<RunResult>;
  pluginRemove(target: string): Promise<RunResult>;
}

/**
 * The one `codex ... --json` read: `{ [key]: [...] }`. null means the CLI could
 * not answer - which is also what a marketplace whose directory has gone makes
 * of every listing - so every caller must read it as "unknown", never "none".
 */
async function listJson(
  exec: RunCommand,
  codex: string,
  args: string[],
  key: string,
): Promise<unknown[] | null> {
  const res = await exec(codex, [...args, '--json']);
  if (res.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(stripBom(res.stdout));
    return isPlainObject(parsed) && Array.isArray(parsed[key]) ? parsed[key] : null;
  } catch {
    return null;
  }
}

export function codexCli(codex: string, runner: ProcessRunner): CodexCli {
  const exec: RunCommand = runner.run;
  return {
    /**
     * Junk rows are dropped rather than fatal, as for Claude: one unreadable
     * marketplace must not hide the rest. Not memoised, for the same reason
     * either - the harness lists again right after an add to learn the name.
     */
    async listMarketplaces() {
      const entries = await listJson(
        exec,
        codex,
        ['plugin', 'marketplace', 'list'],
        'marketplaces',
      );
      return entries ? entries.filter(isPlainObject) : null;
    },

    /**
     * Read whole or not at all. Only the `installed` half: `available` is what
     * a marketplace offers, and nothing here is decided from it.
     */
    async listPlugins() {
      const entries = await listJson(exec, codex, ['plugin', 'list'], 'installed');
      if (!entries) return null;
      const rows = entries.flatMap((e) => {
        if (!isPlainObject(e) || !nonEmptyString(e.pluginId)) return [];
        // `plugin@marketplace`, where the marketplace half is Codex's own name for it.
        const at = e.pluginId.lastIndexOf('@');
        return [
          {
            plugin: at > 0 ? e.pluginId.slice(0, at) : e.pluginId,
            marketplace: at > 0 ? e.pluginId.slice(at + 1) : null,
          },
        ];
      });
      return rows.length === entries.length ? rows : null;
    },

    marketplaceAdd(source) {
      return exec(codex, ['plugin', 'marketplace', 'add', source]);
    },

    marketplaceUpgrade(name) {
      return exec(codex, ['plugin', 'marketplace', 'upgrade', name]);
    },

    marketplaceRemove(name) {
      return exec(codex, ['plugin', 'marketplace', 'remove', name]);
    },

    pluginAdd(target) {
      return exec(codex, ['plugin', 'add', target]);
    },

    pluginRemove(target) {
      return exec(codex, ['plugin', 'remove', target]);
    },
  };
}
