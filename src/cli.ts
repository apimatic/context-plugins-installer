import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBrand } from './brand.js';
import { diagnose } from './doctor.js';
import { NAMES, byName } from './harness/index.js';
import { installPlugin, uninstallPlugin, updateAll, listPlugins } from './install.js';
import { log } from './log.js';
import * as manifest from './manifest.js';
import * as paths from './paths.js';
import type { Brand, DoctorStatus, Flags, ParsedArgs, Profile } from './types.js';
import { UserError, isPlainObject, errorMessage } from './util.js';

// package.json is one directory up from both src/ (tests) and lib/ (published).
function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );
  return isPlainObject(parsed) && typeof parsed.version === 'string' ? parsed.version : 'unknown';
}

const VALUE_FLAGS = ['repo', 'ref', 'marketplace', 'targets'] as const;
const BOOL_FLAGS = ['force', 'yes', 'long', 'verbose', 'quiet', 'json', 'help', 'version'] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];

const isValueFlag = (key: string): key is ValueFlag => VALUE_FLAGS.some((f) => f === key);
const isBoolFlag = (key: string): key is BoolFlag => BOOL_FLAGS.some((f) => f === key);

// A plugin id longer than this is ignored when sizing the list grid.
const OUTLIER_NAME = 36;

const camel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Flags = {};
  const positional: string[] = [];
  const rest = [...argv];

  for (;;) {
    const token = rest.shift();
    if (token === undefined) break;

    if (token === '--') {
      positional.push(...rest);
      break;
    }
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-v' || token === '-V') {
      flags.version = true;
      continue;
    }
    if (token === '-y') {
      flags.yes = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const key = camel(rawName);

    if (isValueFlag(key)) {
      const value = inline !== null ? inline : rest.shift();
      if (value === undefined) throw new UserError(`--${rawName} needs a value`);
      flags[key] = value;
      continue;
    }
    const negated = key.startsWith('no') && key.length > 2 ? lowerFirst(key.slice(2)) : null;
    if (negated && isBoolFlag(negated)) {
      flags[negated] = false;
      continue;
    }
    if (isBoolFlag(key)) {
      flags[key] = inline === null ? true : inline !== 'false';
      continue;
    }
    throw new UserError(`Unknown option: ${token}`, { hint: 'Run with --help for usage.' });
  }

  return { command: positional.shift() || null, args: positional, flags };
}

export const parseTargets = (value?: string): string[] | null =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

export function helpText(bin: string, brand: Pick<Brand, 'displayName' | 'label' | 'ref'>): string {
  return `
${brand.displayName} - install marketplace plugins into Claude Code, Cursor, and VS Code.

Usage
  ${bin} install <plugin> [options]
  ${bin} uninstall <plugin> [options]
  ${bin} update
  ${bin} list
  ${bin} installed
  ${bin} doctor

Options
  --repo <owner/repo>   Use a different marketplace   (default: ${brand.label})
  --ref <branch|tag|sha> Version to install from       (default: ${brand.ref})
  --marketplace <name>  Marketplace name              (default: read from the marketplace)
  --targets <list>      Comma-separated: ${NAMES.join(', ')}, all   (skips the prompt)
  -y, --yes             Accept every detected harness without asking
  --force               Replace a plugin installed from another marketplace
  --long                Show plugin descriptions (list)
  --json                Machine-readable output (list, installed)
  --verbose             Show underlying git / CLI detail
  --quiet               Suppress progress output
  -h, --help            Show this help
  -v, --version         Show the version

Environment
  CP_PLUGIN, CP_REPO, CP_REF, CP_MARKETPLACE   Defaults for the options above
  GITHUB_TOKEN                                  Raises the GitHub API rate limit
  CP_STATE_DIR                                  Override ~/.context-plugins

Examples
  ${bin} install paypal
  ${bin} install acme-payments --repo acme/plugin-marketplace
  ${bin} install paypal --targets cursor,vscode --ref v1.2.0
  ${bin} uninstall paypal
`.trimStart();
}

function report(err: unknown): void {
  if (err instanceof UserError) {
    log.error(err.message);
    if (err.hint) log.info(err.hint);
    return;
  }
  log.error(errorMessage(err));
  if (log.isVerbose && err instanceof Error && err.stack) log.plain(err.stack);
}

const DOCTOR_SYMBOL: Record<DoctorStatus, string> = { ok: log.MARK, warn: '!', fail: 'x' };

/** Returns the process exit code. */
export async function run(
  argv: readonly string[] = process.argv.slice(2),
  profile: Profile = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    report(err);
    return 2;
  }

  const { command, args, flags } = parsed;
  log.setVerbose(flags.verbose);
  log.setQuiet(flags.quiet);

  // Before the brand resolves, so a broken rc file cannot hide the version.
  if (flags.version) {
    log.plain(packageVersion());
    return 0;
  }

  let brand: Brand;
  try {
    brand = resolveBrand({ flags, profile });
  } catch (err) {
    report(err);
    return 2;
  }

  const bin = profile.bin || brand.bin;
  if (flags.help || !command || command === 'help') {
    log.plain(helpText(bin, brand));
    return command || flags.help ? 0 : 2;
  }

  const targets = parseTargets(flags.targets);
  const plugin = args[0] || process.env.CP_PLUGIN || null;

  try {
    switch (command) {
      case 'install': {
        if (!plugin) {
          throw new UserError('No plugin specified.', {
            hint: `Usage: ${bin} install <plugin>   (or set CP_PLUGIN)`,
          });
        }
        await installPlugin({
          brand,
          plugin,
          ref: flags.ref,
          targets,
          force: flags.force,
          assumeYes: flags.yes,
        });
        return 0;
      }
      case 'uninstall':
      case 'remove': {
        if (!plugin) {
          throw new UserError('No plugin specified.', { hint: `Usage: ${bin} uninstall <plugin>` });
        }
        await uninstallPlugin({ brand, plugin, targets });
        return 0;
      }
      case 'update': {
        const result = await updateAll({ brand });
        return result.failed.length ? 1 : 0;
      }
      case 'list': {
        const result = await listPlugins({ brand });
        if (flags.json) {
          log.payload(JSON.stringify(result, null, 2));
          return 0;
        }
        const plugins = [...result.plugins].sort((a, b) => a.name.localeCompare(b.name));
        log.banner(`${log.plural(plugins.length, 'plugin')} in ${result.label}`);
        log.plain('');

        if (flags.long) {
          for (const p of plugins) {
            const mark = p.installed ? log.MARK : ' ';
            log.plain(`  ${mark} ${log.bold(p.name)}`);
            if (p.description) log.info(p.description);
            if (p.targets.length) {
              log.info(`Installed into: ${p.targets.map((n) => byName(n).title).join(', ')}`);
            }
          }
        } else {
          // A grid sized to the longest non-outlier name: one very long id would
          // otherwise set the width for every column and collapse the grid.
          const lengths = plugins.map((p) => p.name.length);
          const cell = Math.max(16, ...lengths.filter((l) => l <= OUTLIER_NAME)) + 3;
          const cols = Math.max(1, Math.floor((log.width(120) - 2) / cell));
          const rows = Math.ceil(plugins.length / cols);
          for (let r = 0; r < rows; r += 1) {
            let line = '  ';
            for (let c = 0; c < cols; c += 1) {
              const p = plugins[c * rows + r]; // column-major keeps A-Z reading down
              if (!p) continue;
              line += `${p.installed ? log.MARK : ' '} ${p.name.padEnd(cell - 2)}`;
            }
            log.plain(line.trimEnd());
          }
        }

        log.plain('');
        const count = plugins.filter((p) => p.installed).length;
        if (count) {
          log.info(`${log.MARK} installed on this machine (${count})`);
        }
        if (!flags.long) log.info(`Run \`${bin} list --long\` for descriptions.`);
        log.info(`Install one with \`${bin} install <plugin>\`.`);
        return 0;
      }
      case 'doctor': {
        const report = await diagnose({ brand });
        if (flags.json) {
          log.payload(JSON.stringify(report, null, 2));
          return report.ok ? 0 : 1;
        }

        const labels = report.groups.flatMap((g) => g.checks.map((c) => c.label.length));
        const labelWidth = Math.min(Math.max(...labels, 8), 22);
        for (const group of report.groups) {
          log.step(group.title);
          for (const c of group.checks) {
            const symbol = DOCTOR_SYMBOL[c.status];
            const paint = c.status === 'ok' ? log.dim : (s: string) => s;
            log.plain(`  ${symbol}   ${c.label.padEnd(labelWidth)}  ${paint(c.detail)}`);
            if (c.hint) log.info(c.hint);
          }
        }

        log.plain('');
        log.rule();
        if (report.failures) {
          log.error(`${log.plural(report.failures, 'problem')} found.`);
        } else if (report.warnings) {
          log.ok(`No problems. ${log.plural(report.warnings, 'warning')}.`);
        } else {
          log.ok('Everything checks out.');
        }
        log.plain('');
        return report.ok ? 0 : 1;
      }
      case 'installed': {
        const { plugins: entries, ignored, elided } = manifest.read(paths.manifestPath());
        // Every way the read view differs from the file: rows it dropped, and
        // rows it listed without a target name this build does not know.
        const warnGaps = (emit: (msg: string) => void) => {
          for (const skip of ignored) {
            const label = skip.plugin ? `'${skip.plugin}'` : 'an entry';
            emit(`Ignoring ${label} in installed.json - ${skip.reason}.`);
          }
          for (const row of elided) {
            const names = row.targets.join(', ');
            emit(
              `Listing '${row.plugin}' without unknown target(s): ${names} - the entry on disk keeps them.`,
            );
          }
        };
        if (flags.json) {
          // Schema stability: the payload stays the plain entry array, so what it
          // cannot represent is reported on stderr instead.
          warnGaps(log.warnStderr);
          log.payload(JSON.stringify(entries, null, 2));
          return 0;
        }
        if (!entries.length) {
          warnGaps(log.warn);
          log.info('No plugins installed yet.');
          log.info(`Browse what is available with:  ${bin} list`);
          return 0;
        }
        log.banner(`${log.plural(entries.length, 'plugin')} installed`);
        log.plain('');
        const idWidth = Math.min(Math.max(...entries.map((e) => e.plugin.length), 4), 42);
        for (const e of entries) {
          const where = e.targets.map((n) => byName(n).title);
          log.plain(`    ${e.plugin.padEnd(idWidth)}  ${log.dim(where.join(', '))}`);
          log.debug(`${e.repo}@${e.ref}  (marketplace: ${e.marketplace})`);
        }
        warnGaps(log.warn);
        log.plain('');
        return 0;
      }
      default:
        throw new UserError(`Unknown command: ${command}`, {
          hint: `Run \`${bin} --help\` for usage.`,
        });
    }
  } catch (err) {
    report(err);
    return 1;
  }
}
