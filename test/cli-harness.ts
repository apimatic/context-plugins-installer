import * as fs from 'node:fs';
import * as path from 'node:path';

import { run as route } from '../src/commands/router.js';
import { run } from '../src/main.js';
import type { Services } from '../src/types/services.js';
import { silenceConsole, tmpDir } from './helpers.js';

// Drives a whole command through the real entry point against a manifest - and
// a brand - only the calling test can see. Shared, because every command's
// tests need it and each phase moves one more of them out of cli.test.ts.

/** run() reads the brand from the ambient cwd, home and CP_* env, so pin all of them. */
const AMBIENT = [
  'CP_STATE_DIR',
  'CP_REPO',
  'CP_REF',
  'CP_MARKETPLACE',
  'CP_TELEMETRY',
  'DO_NOT_TRACK',
  'HOME',
  'USERPROFILE',
];

export const noAnsi = (text: string): string => text.replace(/\x1b\[\d+m/g, '');

export interface CliRun {
  code: number;
  root: string;
  /** stdout verbatim, so a `--json` payload still parses. */
  out: string;
  /** The same lines rewrapped, so a wrapped warning matches as one sentence. */
  text: string;
  err: string;
}

async function inSandbox(
  manifestDoc: unknown,
  env: Record<string, string>,
  root: string,
  drive: () => Promise<number>,
): Promise<CliRun> {
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'installed.json'), JSON.stringify(manifestDoc), 'utf8');

  // The caller's own keys are saved too, not just the ambient ones: a test that
  // stubs `PATH` to keep a real `claude` out of the run would otherwise leave it
  // stubbed for every test that follows.
  const pinned = [...new Set([...AMBIENT, ...Object.keys(env)])];
  const saved = pinned.map((k) => [k, process.env[k]] as const);
  const prevCwd = process.cwd();
  for (const key of AMBIENT) delete process.env[key];
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere; a developer's
  // own .contextpluginsrc must not decide what this test sees.
  process.env.CP_STATE_DIR = state;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  // run() has no deps seam, so the real Mixpanel endpoint is one env var away:
  // off unless a test pins fetch and says otherwise.
  process.env.CP_TELEMETRY = 'off';
  process.chdir(root);

  Object.assign(process.env, env);

  const con = silenceConsole();
  try {
    const code = await drive();
    const flatten = (lines: string[]) =>
      noAnsi(lines.join(' ')).split(' ').filter(Boolean).join(' ');
    return {
      code,
      root,
      out: con.out.join('\n'),
      text: flatten(con.out),
      err: flatten(con.err),
    };
  } finally {
    con.restore();
    process.chdir(prevCwd);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The whole run, through the real entry point and the real composition root. */
export const runCli = (
  args: string[],
  manifestDoc: unknown,
  env: Record<string, string> = {},
  root = tmpDir('cp-cli-'),
): Promise<CliRun> => inSandbox(manifestDoc, env, root, () => run(args));

/**
 * The same sandbox, with the router handed its services. `runCli` builds the
 * real ones, which reach the network and whatever `claude` is on PATH, so
 * `install`, `uninstall` and `update` cannot be driven through it - and this is
 * the only seam that reaches the router's own flag-to-request translation.
 * Every other test of those three commands enters at the command, past the
 * object literal the router builds, which is how five forwarded flags came to
 * be pinned by nothing: replacing `targets`, `force` and `assumeYes` with
 * constants there left the whole suite green.
 */
export const runRouter = (
  args: string[],
  services: Services,
  manifestDoc: unknown,
  env: Record<string, string> = {},
  root = tmpDir('cp-cli-'),
): Promise<CliRun> => inSandbox(manifestDoc, env, root, () => route(args, services));
