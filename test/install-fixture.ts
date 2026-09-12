import * as fs from 'node:fs';
import * as path from 'node:path';

import type { InstallRequest } from '../src/actions/install.js';
import type { UninstallRequest } from '../src/actions/uninstall.js';
import type { UpdateRequest } from '../src/actions/update.js';

import { InstallCommand } from '../src/commands/install.js';
import { UninstallCommand } from '../src/commands/uninstall.js';
import { UpdateCommand } from '../src/commands/update.js';
import { registryClient } from '../src/infrastructure/github-registry-client.js';
import { sourceFetcher } from '../src/infrastructure/source-fetcher.js';
import type { Ask } from '../src/prompts/install.js';
import { createSession } from '../src/infrastructure/session.js';
import { harnesses } from '../src/harnesses/index.js';
import { rawUrl } from '../src/infrastructure/github-registry-client.js';
import { services } from '../src/composition/index.js';
import { announceMarketplace } from '../src/prompts/marketplace.js';
import { log } from '../src/prompts/terminal.js';
import type { Session } from '../src/types/session.js';
import type { InstallReport, UninstallResult, UpdateReport } from '../src/types/reports.js';
import { DirectoryPath } from '../src/types/file/paths.js';
import type { EventSink } from '../src/types/events/domain-event.js';
import type { Harness, HarnessName, HarnessOpts } from '../src/types/harness.js';
import type { FetchLike, RegistryClient, SourceFetcher, SourcePorts } from '../src/types/ports.js';
import { ok } from '../src/types/result.js';
import {
  portsFor,
  resolveBrand,
  runnerFor,
  silenceConsole,
  stubFetch,
  throwFailure,
  tmpDir,
} from './helpers.js';

// The sandboxed machine every install-shaped test is built on. Shared because
// `install` and `update` are the same machinery from two directions, and their
// tests live in different files now.

// Claude Code is deliberately excluded from these targets: it shells out to a
// real `claude` binary that may be installed on the machine running the tests.
export const TARGETS: HarnessName[] = ['cursor', 'vscode'];

/**
 * The three entry points this suite drives, as `src/install.ts` used to offer
 * them: run the command, and turn a `Failure` back into the throw several
 * hundred assertions are written against. They are test scaffolding now - the
 * router is the only caller a released build has, and it reads the result.
 */
export async function installPlugin({
  wiring: w,
  session,
  sink,
  ...req
}: InstallRequest & {
  wiring: Wiring;
  session?: Session;
  sink?: EventSink;
}): Promise<InstallReport> {
  const own = !session;
  const run = session ?? sessionOver(w);
  try {
    const result = await new InstallCommand(guarded(sink)).run(req, run);
    if (result.failure) throwFailure(result.failure);
    return result.report;
  } finally {
    if (own) await run.cleanup();
  }
}

export async function uninstallPlugin({
  wiring: w,
  sink,
  ...req
}: UninstallRequest & { wiring: Wiring; sink?: EventSink }): Promise<UninstallResult> {
  const result = await new UninstallCommand(guarded(sink), w.registry).run(req);
  if (result.failure) throwFailure(result.failure);
  return result.report;
}

/** No throw: `update` reports per row, and its failures are in the report. */
export async function updateAll({
  wiring: w,
  session,
  sink,
  ...req
}: UpdateRequest & {
  wiring: Wiring;
  session?: Session;
  sink?: EventSink;
}): Promise<UpdateReport> {
  const own = !session;
  const run = session ?? sessionOver(w);
  try {
    return (await new UpdateCommand(guarded(sink)).run(req, run)).report;
  } finally {
    if (own) await run.cleanup();
  }
}

/**
 * A sink that cannot fail the run it is listening to - the composition root's
 * own, wrapped around the test's collector rather than a second copy of it, so
 * that the test which proves a throwing sink cannot fail a run proves the one
 * that ships. Absent means nobody is listening.
 */
const guarded = (sink?: EventSink): EventSink =>
  sink
    ? services().sink({ report: sink, flush: async () => [] }, (message) => log.debug(message))
    : () => {};

/**
 * Wiring for a run that never fetches a plugin - an uninstall, mostly. The
 * fetcher is the real one over a stub fetch, because nothing should reach it:
 * if a test does, it fails loudly rather than quietly using a stub directory.
 */
export const registryOnly = (fetch: FetchLike): Wiring => {
  const ports = portsFor(fetch);
  return { ports, registry: registryClient(ports), fetcher: sourceFetcher(ports) };
};

/** One session over a test's wiring, announcing what it does like a real run. */
export const sessionOver = (w: Wiring): Session =>
  createSession({ registry: w.registry, fetcher: w.fetcher, notify: announceMarketplace });

/**
 * A sandboxed machine: its own state dir, Cursor dir, and VS Code user dir.
 * `pathOpts` is checked with `satisfies HarnessOpts` rather than annotated as
 * one: that is what it is forwarded as - the commands hand it straight to the
 * harnesses - so a field that no longer exists on that type is refused here,
 * while the three sandbox variables keep their exact string types for the
 * tests that read them.
 */
export function machine() {
  const root = tmpDir('cp-machine-');
  const env = {
    CP_STATE_DIR: path.join(root, 'state'),
    CP_CURSOR_DIR: path.join(root, '.cursor'),
    CP_VSCODE_USER_DIR: path.join(root, 'code-user'),
  };
  fs.mkdirSync(env.CP_CURSOR_DIR, { recursive: true }); // Cursor "installed"
  fs.mkdirSync(env.CP_VSCODE_USER_DIR, { recursive: true }); // VS Code "installed"
  return { root, pathOpts: { env, home: root } satisfies HarnessOpts };
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

export interface WiringSpec {
  repo: string;
  marketplace?: string;
  plugin?: string;
  srcDir: string;
}

/**
 * What a run reaches the outside through, for a test: a registry that answers
 * with one plugin, and a fetcher that hands over a directory instead of cloning
 * one. This replaced the `Deps` bag - the difference is that these are the
 * services production takes, built over a stub fetch, rather than a set of
 * optional hooks production had to know about.
 */
export interface Wiring {
  registry: RegistryClient;
  fetcher: SourceFetcher;
  ports: SourcePorts;
}

export function wiring({
  repo,
  marketplace = 'apimatic',
  plugin = 'my-sdk',
  srcDir,
}: WiringSpec): Wiring {
  const ports = portsFor(
    stubFetch({
      [rawUrl(repo, 'main', '.claude-plugin/marketplace.json')]: {
        body: { name: marketplace, plugins: [{ name: plugin, source: `./plugins/${plugin}` }] },
      },
    }),
  );
  return {
    ports,
    registry: registryClient(ports),
    fetcher: {
      openRepo: async () => ({
        via: 'api',
        cleanup: () => {},
        checkout: async () => ok(new DirectoryPath(srcDir)),
      }),
    },
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
  const env = { ...m.pathOpts.env, PATH: bin, PATHEXT: '.CMD' };
  // The runner, not a bare `run`: the two stub files above make `claude`
  // findable, and this makes every spawn of it answer from the routes above
  // rather than execute them. Handing over only one of the two is how this fake
  // silently stopped being used when the seam moved - the stubs exit 0, so an
  // install that should have failed passed instead, and only a behavioural test
  // noticed. The return is annotated `Machine` for the same reason: without it
  // the object literal has no target type, so a field that no longer exists is
  // dropped in silence rather than refused.
  return {
    ...m,
    pathOpts: { ...m.pathOpts, env, runner: runnerFor(run, env) } satisfies HarnessOpts,
  };
}

/** Unlike `withClaude`, this fake answers every call, not just a listing. */
export type ClaudeMachine = ReturnType<typeof withClaude> & { calls: string[] };

export function claudeMachine(): ClaudeMachine {
  const m = withClaude(machine());
  const calls: string[] = [];
  const runner = {
    which: m.pathOpts.runner?.which ?? ((): string | null => null),
    run: async (_file: string, args: string[]) => {
      const line = args.join(' ');
      calls.push(line);
      if (line.startsWith('plugin list')) return { code: 0, stdout: '[]', stderr: '' };
      if (line.startsWith('plugin marketplace list')) return { code: 0, stdout: '[]', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { ...m, pathOpts: { ...m.pathOpts, runner }, calls };
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

export const sinkInto =
  (events: Tracked[]): EventSink =>
  (event) => {
    events.push({ name: event.name, properties: event.properties() });
  };

export type Confirm = Ask & { asked: string[] };

/** Answers the first question with the interrupt a real prompter reports. */
export function cancellingConfirm(): Confirm {
  const asked: string[] = [];
  const fn = async (question: string): Promise<'cancelled'> => {
    asked.push(question);
    return 'cancelled';
  };
  return Object.assign(fn, { asked });
}

/** Records what was asked, and answers from a scripted list of booleans. */
export function scriptedConfirm(answers: boolean[]): Confirm {
  const asked: string[] = [];
  const fn = async (question: string): Promise<boolean> => {
    asked.push(question);
    return answers.shift() ?? true;
  };
  return Object.assign(fn, { asked });
}
