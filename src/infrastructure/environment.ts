import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';

import type { Env } from '../types/env.js';
import { envFlag, isPlainObject } from '../util.js';

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

export function isInteractive(env: Env = process.env): boolean {
  if (isCi(env)) return false;
  if (env.CP_NO_INPUT) return false;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

// Two directories up from both src/infrastructure (tests) and lib/infrastructure
// (published) - one deeper than when this sat in cli.ts. Left able to throw, as
// it was: the telemetry sender already wraps it, and `--version` reporting a
// version it could not read would be worse than saying so.
export function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  return isPlainObject(parsed) && typeof parsed.version === 'string' ? parsed.version : 'unknown';
}
