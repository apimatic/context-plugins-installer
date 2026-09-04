import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';

import type { Env } from '../types/env.js';
import { envFlag, isPlainObject, stripBom } from '../util.js';

// What this process can tell about the machine and the session it runs in.
// Whether the *terminal* can render a glyph or a colour is a separate question,
// and it stays in prompts/terminal.ts: the prompts layer may not reach in here,
// so Phase 6's router is what reads an environment and configures a terminal.

const CI_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'TF_BUILD',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
];

/** The one definition of "running in CI": the prompt and telemetry must agree on it. */
export const isCi = (env: Env = process.env): boolean => CI_VARS.some((name) => envFlag(env[name]));

/** Whether each end of the terminal is attached; a parameter so it can be described. */
export interface TtyState {
  stdin: boolean;
  stdout: boolean;
}

const hostTty = (): TtyState => ({ stdin: Boolean(stdin.isTTY), stdout: Boolean(stdout.isTTY) });

/**
 * `tty` is a parameter because under a test runner neither end is a terminal,
 * so a test that only varies the environment cannot tell whether the CI and
 * CP_NO_INPUT guards decided anything - the TTY check answers false either way
 * and every assertion passes with both guards deleted.
 */
export function isInteractive(env: Env = process.env, tty: TtyState = hostTty()): boolean {
  if (isCi(env)) return false;
  if (env.CP_NO_INPUT) return false;
  return tty.stdin && tty.stdout;
}

// Two directories up from both src/infrastructure (tests) and lib/infrastructure
// (published) - one deeper than when this sat in cli.ts. Left able to throw, as
// it was: the telemetry sender already wraps it, and `--version` reporting a
// version it could not read would be worse than saying so.
export function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    stripBom(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')),
  );
  return isPlainObject(parsed) && typeof parsed.version === 'string' ? parsed.version : 'unknown';
}
