import type { Flags, ParsedArgs } from '../types/args.js';
import { Failure } from '../types/failure.js';
import { err, ok, type Result } from '../types/result.js';

// The whole parser: a typed flag table and one pass over argv. Weighed against
// oclif and rejected, because a dependency-free package is the point - and
// because a table this small is easier to read than the framework that would
// replace it.

const VALUE_FLAGS = ['repo', 'ref', 'marketplace', 'targets'] as const;
const BOOL_FLAGS = ['force', 'yes', 'long', 'verbose', 'quiet', 'json', 'help', 'version'] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];

const isValueFlag = (key: string): key is ValueFlag => VALUE_FLAGS.some((f) => f === key);
const isBoolFlag = (key: string): key is BoolFlag => BOOL_FLAGS.some((f) => f === key);

const camel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Commands that read `--targets`; anywhere else it is a no-op worth saying so. */
export const TARGET_AWARE = new Set(['install', 'uninstall', 'remove', 'installed']);

/**
 * A `Failure` rather than a throw: a command line this parser cannot read is
 * the one thing that exits 2, and the router decides that from the shape of
 * the answer rather than from the class of an exception.
 */
export function parseArgs(argv: readonly string[]): Result<ParsedArgs, Failure> {
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
      if (value === undefined) return err(new Failure(`--${rawName} needs a value`));
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
    return err(new Failure(`Unknown option: ${token}`, 'Run with --help for usage.'));
  }

  return ok({ command: positional.shift() || null, args: positional, flags });
}

export const parseTargets = (value?: string): string[] | null =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
