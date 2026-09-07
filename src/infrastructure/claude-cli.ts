import type { Env } from '../types/env.js';
import type { InstalledPlugin, MarketplaceListing } from '../types/harness.js';
import type { RunCommand, RunResult } from '../types/ports.js';
import { isPlainObject, nonEmptyString, stripBom } from '../util.js';
import { run, which } from './process-runner.js';

/** null when the CLI is not on PATH, which every caller reads as "cannot ask". */
export const findClaude = (env: Env = process.env): string | null => which('claude', env);

/**
 * Everything this program says to the `claude` binary, and the only place its
 * argv is spelled. The listing methods are the validated boundary: they answer
 * with rows this build could read or `null` for "the CLI could not answer",
 * never with a guess. The command methods answer with the process result,
 * because a non-zero exit from `claude` is not a failure to report but evidence
 * to interpret - whether a missing plugin means "not installed" or "the local
 * marketplace copy is stale" is the harness's decision, and it needs the exit
 * code and the output to make it.
 */
export interface ClaudeCli {
  listMarketplaces(): Promise<MarketplaceListing[] | null>;
  listPlugins(): Promise<InstalledPlugin[] | null>;
  marketplaceAdd(repo: string): Promise<RunResult>;
  marketplaceUpdate(name: string): Promise<RunResult>;
  pluginInstall(target: string, scope: string): Promise<RunResult>;
  pluginUninstall(target: string, scope: string): Promise<RunResult>;
}

/**
 * The one `claude ... --json` read: a bare array, or `{ [key]: [...] }`. null
 * means the CLI could not answer - too old for `--json`, or a shape this build
 * cannot read - which every caller must treat as "unknown", never "none".
 */
async function listJson(
  exec: RunCommand,
  claude: string,
  args: string[],
  key: string,
): Promise<unknown[] | null> {
  const res = await exec(claude, [...args, '--json']);
  if (res.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(stripBom(res.stdout));
    if (Array.isArray(parsed)) return parsed;
    return isPlainObject(parsed) && Array.isArray(parsed[key]) ? parsed[key] : null;
  } catch {
    return null;
  }
}

export function claudeCli(claude: string, exec: RunCommand = run): ClaudeCli {
  return {
    /**
     * Junk rows are dropped rather than fatal: one unreadable marketplace must
     * not hide the rest, and the worst case is re-adding one that was there.
     *
     * Do not memoise this. The harness calls it again immediately after
     * `marketplaceAdd` to learn the name Claude filed the marketplace under,
     * which is the whole point of that call; a cached listing would answer with
     * the state from before the add and the install would use the configured
     * name instead. `test/claude.test.ts` fails on exactly that.
     */
    async listMarketplaces() {
      const entries = await listJson(
        exec,
        claude,
        ['plugin', 'marketplace', 'list'],
        'marketplaces',
      );
      return entries ? entries.filter(isPlainObject) : null;
    },

    /**
     * Read whole or not at all, the opposite policy to marketplaces: absence is
     * the only conclusion drawn from this listing, so one row that will not
     * parse makes the answer unknown rather than "nothing is installed".
     */
    async listPlugins() {
      const entries = await listJson(exec, claude, ['plugin', 'list'], 'plugins');
      if (!entries) return null;
      const rows = entries.flatMap((e) => {
        if (!isPlainObject(e) || !nonEmptyString(e.id)) return [];
        // `plugin@marketplace`, where the marketplace half is Claude's own name for it.
        const at = e.id.lastIndexOf('@');
        return [
          {
            plugin: at > 0 ? e.id.slice(0, at) : e.id,
            scope: nonEmptyString(e.scope) ? e.scope : null,
          },
        ];
      });
      return rows.length === entries.length ? rows : null;
    },

    marketplaceAdd(repo) {
      return exec(claude, ['plugin', 'marketplace', 'add', repo]);
    },

    marketplaceUpdate(name) {
      return exec(claude, ['plugin', 'marketplace', 'update', name]);
    },

    pluginInstall(target, scope) {
      return exec(claude, ['plugin', 'install', target, '--scope', scope]);
    },

    pluginUninstall(target, scope) {
      return exec(claude, ['plugin', 'uninstall', target, '--scope', scope]);
    },
  };
}
