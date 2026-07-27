'use strict';

const log = require('./log');
const paths = require('./paths');
const manifest = require('./manifest');
const { resolveBrand } = require('./brand');
const { NAMES, byName } = require('./harness');
const { UserError } = require('./util');
const { installPlugin, uninstallPlugin, updateAll, listPlugins } = require('./install');
const pkg = require('../package.json');

const VALUE_FLAGS = new Set(['repo', 'ref', 'marketplace', 'targets']);
const BOOL_FLAGS = new Set(['force', 'yes', 'verbose', 'quiet', 'json', 'help', 'version']);

const camel = (s) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const rest = [...argv];

  while (rest.length) {
    const token = rest.shift();

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

    if (VALUE_FLAGS.has(key)) {
      const value = inline !== null ? inline : rest.shift();
      if (value === undefined) throw new UserError(`--${rawName} needs a value`);
      flags[key] = value;
      continue;
    }
    const negated = key.startsWith('no') && key.length > 2 ? lowerFirst(key.slice(2)) : null;
    if (negated && BOOL_FLAGS.has(negated)) {
      flags[negated] = false;
      continue;
    }
    if (BOOL_FLAGS.has(key)) {
      flags[key] = inline === null ? true : inline !== 'false';
      continue;
    }
    throw new UserError(`Unknown option: ${token}`, { hint: 'Run with --help for usage.' });
  }

  return { command: positional.shift() || null, args: positional, flags };
}

const parseTargets = (value) =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null;

function helpText(bin, brand) {
  return `
${brand.displayName} - install marketplace plugins into Claude Code, Cursor, and VS Code.

Usage
  ${bin} install <plugin> [options]
  ${bin} uninstall <plugin> [options]
  ${bin} update
  ${bin} list
  ${bin} installed

Options
  --repo <owner/repo>   Use a different marketplace   (default: ${brand.label})
  --ref <branch|tag|sha> Version to install from       (default: ${brand.ref})
  --marketplace <name>  Marketplace name              (default: read from the marketplace)
  --targets <list>      Comma-separated: ${NAMES.join(', ')}, all   (skips the prompt)
  -y, --yes             Accept every detected harness without asking
  --force               Replace a plugin installed from another marketplace
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
  ${bin} install discourse-api-documentation-sdk
  ${bin} install acme-payments-sdk --repo acme/plugin-marketplace
  ${bin} install my-sdk --targets cursor,vscode --ref v1.2.0
  ${bin} uninstall my-sdk
`.trimStart();
}

function report(err) {
  if (err instanceof UserError) {
    log.error(err.message);
    if (err.hint) log.info(err.hint);
    return;
  }
  log.error(err && err.message ? err.message : String(err));
  if (log.isVerbose && err && err.stack) log.plain(err.stack);
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object} profile Preset configuration (see run.js)
 * @returns {Promise<number>} process exit code
 */
async function run(argv = process.argv.slice(2), profile = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    report(err);
    return 2;
  }

  const { command, args, flags } = parsed;
  log.setVerbose(flags.verbose);
  log.setQuiet(flags.quiet);

  let brand;
  try {
    brand = resolveBrand({ flags, profile });
  } catch (err) {
    report(err);
    return 2;
  }

  const bin = profile.bin || brand.bin;

  if (flags.version) {
    log.plain(pkg.version);
    return 0;
  }
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
          log.plain(JSON.stringify(result, null, 2));
          return 0;
        }
        log.banner(`${result.plugins.length} plugin(s) in ${result.label}`);
        for (const p of result.plugins) {
          log.plain(`  ${p.installed ? '*' : ' '} ${p.name}`);
          if (p.description) log.info(p.description);
        }
        log.plain('');
        log.info('* = installed on this machine');
        return 0;
      }
      case 'installed': {
        const entries = manifest.list(paths.manifestPath());
        if (flags.json) {
          log.plain(JSON.stringify(entries, null, 2));
          return 0;
        }
        if (!entries.length) {
          log.info('No plugins installed by this tool yet.');
          return 0;
        }
        log.banner(`${entries.length} plugin(s) installed`);
        for (const e of entries) {
          const where = (e.targets || []).map((n) => (byName(n) ? byName(n).title : n));
          log.plain(`  ${e.plugin}  [${where.join(', ')}]`);
          log.debug(`${e.repo}@${e.ref}  (marketplace: ${e.marketplace})`);
        }
        return 0;
      }
      default:
        throw new UserError(`Unknown command: ${command}`, {
          hint: `Run \`${bin} --help\` for usage.`,
        });
    }
  } catch (err) {
    report(err);
    return err instanceof UserError ? 1 : 1;
  }
}

module.exports = { run, parseArgs, parseTargets, helpText };
