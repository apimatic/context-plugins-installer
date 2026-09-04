import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Env } from '../types/env.js';
import type { RunResult } from '../types/ports.js';

/** PATH lookup that honours PATHEXT, so spawning never needs shell: true. */
export function which(cmd: string, env: Env = process.env): string | null {
  const raw = env.PATH || env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of raw.split(sep)) {
    if (!dir) continue;
    const clean = dir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const candidate = path.join(clean, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

const winQuote = (s: string): string => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// Node refuses to spawn .cmd/.bat directly (CVE-2024-27980), and npm-installed
// CLIs land as .cmd shims on Windows, so those go through cmd.exe with an
// explicitly quoted command line.
export function run(file: string, args: string[], opts: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdio: StdioOptions = ['ignore', 'pipe', 'pipe'];
    let child: ChildProcess;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      const line = [file, ...args].map(winQuote).join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        ...opts,
        stdio,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(file, args, { ...opts, stdio });
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d;
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code: number | null) =>
      resolve({ code: code == null ? 1 : code, stdout, stderr }),
    );
  });
}
