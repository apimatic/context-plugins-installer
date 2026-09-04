import * as fs from 'node:fs';
import * as path from 'node:path';

import { BIN, resolveBrand } from './brand.js';
import { diagnose } from './doctor.js';
import { NAMES, byName, titlesOf, everyEditor, resolveTargets } from './harness/index.js';
import { installPlugin, uninstallPlugin, updateAll, listPlugins } from './install.js';
import { log } from './log.js';
import * as manifest from './manifest.js';
import * as paths from './paths.js';
import { format as f } from './prompts/format.js';
import {
  COLLECTED,
  createTelemetry,
  describeTelemetry,
  setTelemetryEnabled,
  telemetryStatus,
} from './telemetry.js';
import type { Flags, ParsedArgs } from './types/args.js';
import type { Brand } from './types/brand.js';
import type { DoctorStatus } from './types/doctor.js';
import type { Manifest } from './types/installed-record.js';
import type { Deps } from './types/ports.js';
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

/**
 * Every way the read view differs from the file: rows it dropped, and rows it
 * listed without a target name this build does not know. `scope` limits them to
 * one marketplace, whose repo is then implied and left out of the label.
 */
export function gapWarnings({ ignored, elided }: Manifest, scope?: string): string[] {
  const inScope = (repo?: string): boolean => !scope || !repo || repo === scope;
  const label = (plugin: string | null, repo?: string): string => {
    const name = plugin ? `'${plugin}'` : 'an entry';
    const where = !scope && repo ? ` (${repo})` : '';
    return `${name}${where}`;
  };
  return [
    ...ignored
      .filter((skip) => inScope(skip.repo))
      .map(
        (skip) => `Ignoring ${label(skip.plugin, skip.repo)} in installed.json - ${skip.reason}.`,
      ),
    ...elided
      .filter((row) => inScope(row.repo))
      .map(
        (row) =>
          `Listing ${label(row.plugin, row.repo)} without unknown target(s): ${row.targets.join(', ')} - the entry on disk keeps them.`,
      ),
  ];
}

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
${brand.displayName} - install marketplace plugins into ${everyEditor('and')}.

Usage
  ${bin} install <plugin> [options]
  ${bin} uninstall <plugin> [options]
  ${bin} update
  ${bin} list
  ${bin} installed
  ${bin} doctor
  ${bin} telemetry [status|enable|disable]

Options
  --repo <owner/repo>   Use a different marketplace   (default: ${brand.label})
  --ref <branch|tag|sha> Version to install from       (default: ${brand.ref})
  --marketplace <name>  Marketplace name              (default: read from the marketplace)
  --targets <list>      Comma-separated: ${NAMES.join(', ')}, all
                        install/uninstall: which editors (skips the prompt)
                        installed: list only what is recorded for them
  -y, --yes             Accept every detected harness without asking
  --force               install: replace a plugin from another marketplace
                        uninstall: drop a record nothing could confirm
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
  CP_TELEMETRY=off, DO_NOT_TRACK=1              Send no anonymous usage data
  CP_TELEMETRY=log                              Print it to stderr instead of sending

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

/** Commands that read `--targets`; anywhere else it is a no-op worth saying so. */
const TARGET_AWARE = new Set(['install', 'uninstall', 'remove', 'installed']);

const TELEMETRY_ACTIONS = ['status', 'enable', 'disable'];

function telemetryCommand(action: string | undefined, brand: Brand, bin: string): number {
  const verb = action ?? 'status';
  if (!TELEMETRY_ACTIONS.includes(verb)) {
    throw new UserError(`Unknown telemetry action: ${verb}`, {
      hint: `Usage: ${bin} telemetry [status|enable|disable]`,
    });
  }
  if (verb !== 'status') {
    const enabled = verb === 'enable';
    if (!setTelemetryEnabled(enabled)) {
      throw new UserError(`Could not write ${f.path(paths.telemetryPath())}.`, {
        hint: enabled
          ? 'Check the permissions on the state directory, or point CP_STATE_DIR somewhere writable.'
          : 'CP_TELEMETRY=off in the environment needs no file.',
      });
    }
    log.ok(`Telemetry ${enabled ? 'enabled' : 'disabled'}.`);
  }

  const status = telemetryStatus({ brand });
  const effective = describeTelemetry(status, bin);
  if (verb === 'status') {
    log.plain(`Telemetry is ${effective}.`);
  } else if (status.mode !== (verb === 'enable' ? 'on' : 'off')) {
    // The choice is saved, but a broader switch still decides what happens.
    log.info(`Right now it is ${effective}; that setting takes precedence.`);
  }
  if (status.id) log.info(`Anonymous machine id: ${status.id} (${f.path(status.file)})`);
  log.info(`Collected: ${COLLECTED}.`);
  log.info(
    `Change it with '${bin} telemetry enable|disable', CP_TELEMETRY=off, or DO_NOT_TRACK=1.`,
  );
  return 0;
}

const DOCTOR_SYMBOL: Record<DoctorStatus, string> = { ok: log.MARK, warn: '!', fail: 'x' };

/** Returns the process exit code. */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
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
    brand = resolveBrand({ flags });
  } catch (err) {
    report(err);
    return 2;
  }

  if (flags.help || !command || command === 'help') {
    log.plain(helpText(BIN, brand));
    return command || flags.help ? 0 : 2;
  }

  const targets = parseTargets(flags.targets);
  const plugin = args[0] || process.env.CP_PLUGIN || null;

  // Silently ignoring it is how `installed --targets vscode` came to answer as
  // though the flag were absent. On stderr, so a `--json` payload stays clean.
  if (targets?.length && command && !TARGET_AWARE.has(command)) {
    log.warnStderr(`--targets does nothing for \`${command}\` - ignoring it.`);
  }

  // One instance per run: install and uninstall report into it, and whatever
  // they reported leaves in a single request once the command is done. `remove`
  // is the same operation as `uninstall`, so it reports as one.
  const telemetry = createTelemetry({
    brand,
    command: command === 'remove' ? 'uninstall' : command,
    version: packageVersion,
  });
  const deps: Deps = { track: telemetry.track };

  try {
    switch (command) {
      case 'install': {
        if (!plugin) {
          throw new UserError('No plugin specified.', {
            hint: `Usage: ${BIN} install <plugin>   (or set CP_PLUGIN)`,
          });
        }
        await installPlugin({
          brand,
          plugin,
          ref: flags.ref,
          targets,
          force: flags.force,
          assumeYes: flags.yes,
          deps,
        });
        return 0;
      }
      case 'uninstall':
      case 'remove': {
        if (!plugin) {
          throw new UserError('No plugin specified.', { hint: `Usage: ${BIN} uninstall <plugin>` });
        }
        await uninstallPlugin({ brand, plugin, targets, force: flags.force, deps });
        return 0;
      }
      case 'update': {
        const result = await updateAll({ brand, deps });
        return result.failed.length ? 1 : 0;
      }
      case 'list': {
        const result = await listPlugins({ brand });
        // Read again rather than widen ListResult: the payload shape is a contract,
        // and the manifest is one small file.
        const gaps = gapWarnings(manifest.read(paths.manifestPath()), brand.repo);
        if (flags.json) {
          for (const msg of gaps) log.warnStderr(msg);
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
              log.info(`Installed into: ${titlesOf(p.targets)}`);
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
        for (const msg of gaps) log.warn(msg);
        if (!flags.long) log.info(`Run \`${BIN} list --long\` for descriptions.`);
        log.info(`Install one with \`${BIN} install <plugin>\`.`);
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
        const data = manifest.read(paths.manifestPath());
        // `--targets` selects which plugins are listed, not what is said about
        // them: each one still shows every editor it is recorded for. Filtering
        // is unconditional because `resolveTargets` reads "nothing asked for" as
        // every editor, and `read()` never yields a row with no known target.
        const want = resolveTargets(targets);
        // Naming every editor adds nothing, so `--targets all` reads as no scope.
        const scope = want.length < NAMES.length ? ` in ${titlesOf(want)}` : '';
        const entries = data.plugins.filter((e) => e.targets.some((t) => want.includes(t)));
        const warnGaps = (emit: (msg: string) => void) => {
          for (const msg of gapWarnings(data)) emit(msg);
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
          log.info(scope ? `No plugins installed${scope}.` : 'No plugins installed yet.');
          log.info(`Browse what is available with:  ${BIN} list`);
          return 0;
        }
        log.banner(`${log.plural(entries.length, 'plugin')} installed${scope}`);
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
      case 'telemetry':
        return telemetryCommand(args[0], brand, BIN);
      default:
        throw new UserError(`Unknown command: ${command}`, {
          hint: `Run \`${BIN} --help\` for usage.`,
        });
    }
  } catch (err) {
    report(err);
    return 1;
  } finally {
    await telemetry.flush();
  }
}
