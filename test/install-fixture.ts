import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBrand } from '../src/brand.js';
import { harnesses } from '../src/harnesses/index.js';
import { rawUrl } from '../src/infrastructure/github-registry-client.js';
import { DirectoryPath } from '../src/types/file/paths.js';
import type { EventSink } from '../src/types/events/domain-event.js';
import type { Harness, HarnessName } from '../src/types/harness.js';
import type { Deps } from '../src/types/ports.js';
import { silenceConsole, stubFetch, tmpDir } from './helpers.js';

// The sandboxed machine every install-shaped test is built on. Shared because
// `install` and `update` are the same machinery from two directions, and their
// tests live in different files now.

// Claude Code is deliberately excluded from these targets: it shells out to a
// real `claude` binary that may be installed on the machine running the tests.
export const TARGETS: HarnessName[] = ['cursor', 'vscode'];

/** A sandboxed machine: its own state dir, Cursor dir, and VS Code user dir. */
export function machine() {
  const root = tmpDir('cp-machine-');
  const env = {
    CP_STATE_DIR: path.join(root, 'state'),
    CP_CURSOR_DIR: path.join(root, '.cursor'),
    CP_VSCODE_USER_DIR: path.join(root, 'code-user'),
  };
  fs.mkdirSync(env.CP_CURSOR_DIR, { recursive: true }); // Cursor "installed"
  fs.mkdirSync(env.CP_VSCODE_USER_DIR, { recursive: true }); // VS Code "installed"
  return { root, pathOpts: { env, home: root } };
}

export type Machine = ReturnType<typeof machine>;

/** A plugin folder as the marketplace would ship it. */
export function pluginSource(name = 'my-sdk'): string {
  const dir = path.join(tmpDir('cp-plugin-'), name);
  fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'dotnet'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'skills', 'dotnet', 'SKILL.md'), '# dotnet skill');
  return dir;
}

export interface DepsSpec {
  repo: string;
  marketplace?: string;
  plugin?: string;
  srcDir: string;
}

export function deps({
  repo,
  marketplace = 'apimatic',
  plugin = 'my-sdk',
  srcDir,
}: DepsSpec): Deps {
  return {
    fetchImpl: stubFetch({
      [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: {
        body: { name: marketplace, plugins: [{ name: plugin, source: `./plugins/${plugin}` }] },
      },
    }),
    env: {},
    materialize: async () => ({ dir: new DirectoryPath(srcDir), cleanup: () => {}, via: 'stub' }),
  };
}

export const brandFor = (repo: string) =>
  resolveBrand({ env: { CP_REPO: repo }, cwd: tmpDir('cp-cwd-'), home: tmpDir('cp-home-') });

/**
 * The same machine with a `claude` on PATH and a fake CLI behind it, so a test
 * can exercise the Claude Code path without touching a real binary.
 */
export function withClaude(m: Machine) {
  const bin = tmpDir('cp-bin-');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\n');
  const run = async (_file: string, args: string[]) => {
    const line = args.join(' ');
    // Nothing registered, nothing installed: every answer is a clean "not here".
    if (line.startsWith('plugin list')) return { code: 0, stdout: '[]', stderr: '' };
    if (line.startsWith('plugin marketplace list')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 1, stdout: '', stderr: 'not found in installed plugins' };
  };
  return {
    ...m,
    pathOpts: {
      ...m.pathOpts,
      env: { ...m.pathOpts.env, PATH: bin, PATHEXT: '.CMD' },
      run,
    },
  };
}

/** Console output as one line, with `log`'s column wrapping collapsed. */
export const flat = (con: { lines: string[] }): string => con.lines.join(' ').replace(/\s+/g, ' ');

export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const con = silenceConsole();
  try {
    return await fn();
  } finally {
    con.restore();
  }
}

/**
 * Runs `fn` with part of one editor's behaviour replaced, and puts the real
 * thing back afterwards. A harness that misbehaves has no seam of its own - the
 * registry hands out instances - and it is the only way to reach some arms:
 * a throw out of `install` is what an `unexpected` failure event is made of,
 * and a throw out of `uninstall` is what the action reads as `'failed'`.
 */
export async function withHarness<T>(
  name: HarnessName,
  patch: Partial<Harness>,
  fn: () => Promise<T>,
): Promise<T> {
  const harness: Partial<Harness> = harnesses.byName(name);
  const keys = Object.keys(patch) as (keyof Harness)[];
  // What was there before, and whether it was the instance's own or the class's.
  // A real implementation lives on the prototype, so restoring it means
  // *deleting* the shadow rather than assigning the old value back - assigning
  // one read through the prototype would have written undefined.
  const saved = keys.map((key) => [key, Object.hasOwn(harness, key), harness[key]] as const);
  Object.assign(harness, patch);
  try {
    return await fn();
  } finally {
    for (const [key, own, value] of saved) {
      if (own) Object.assign(harness, { [key]: value });
      else delete harness[key];
    }
  }
}

/** The one patch two tests want: an editor whose install is a bug. */
export const throwsOnInstall = (message: string): Partial<Harness> => ({
  install: async () => {
    throw new Error(message);
  },
});

/** One event as it left the command: the flat facts, which is what is sent. */
export interface Tracked {
  name: string;
  properties: Record<string, unknown>;
}

/**
 * The deps for an install, plus an event sink that collects into `events`. The
 * sink takes a `DomainEvent`; what the tests read is what it declares, because
 * that - and only that - is what leaves the machine.
 */
export function tracking(spec: DepsSpec, events: Tracked[]): Deps {
  return { ...deps(spec), track: sinkInto(events) };
}

export const sinkInto =
  (events: Tracked[]): EventSink =>
  (event) => {
    events.push({ name: event.name, properties: event.properties() });
  };

export type Confirm = NonNullable<Deps['confirm']> & { asked: string[] };

/** Records what was asked, and answers from a scripted list of booleans. */
export function scriptedConfirm(answers: boolean[]): Confirm {
  const asked: string[] = [];
  const fn = async (question: string): Promise<boolean> => {
    asked.push(question);
    return answers.shift() ?? true;
  };
  return Object.assign(fn, { asked });
}
