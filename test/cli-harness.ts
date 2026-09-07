import * as fs from 'node:fs';
import * as path from 'node:path';

import { run } from '../src/cli.js';
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

export async function runCli(
  args: string[],
  manifestDoc: unknown,
  env: Record<string, string> = {},
  root = tmpDir('cp-cli-'),
): Promise<CliRun> {
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'installed.json'), JSON.stringify(manifestDoc), 'utf8');

  const saved = AMBIENT.map((k) => [k, process.env[k]] as const);
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
    const code = await run(args);
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
