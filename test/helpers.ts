import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  FetchLike,
  FetchResponseLike,
  ProcessRunner,
  RunCommand,
  SourcePorts,
} from '../src/types/ports.js';
import type { Failure } from '../src/types/failure.js';
import type { Env } from '../src/types/env.js';
import type { Result } from '../src/types/result.js';
import { readBrand, type ResolveBrandOptions } from '../src/composition/brand.js';
import { run as realRun, which } from '../src/infrastructure/process-runner.js';
import type { Brand } from '../src/types/brand.js';

const dirs: string[] = [];

export function tmpDir(prefix = 'cp-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupAll(): void {
  for (const dir of dirs.splice(0).reverse()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Minimal, string-aware JSONC -> JSON, so an edited settings.json can be asserted on. */
export function parseJsonc(text: string) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  // strip trailing commas
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

export interface StubRoute {
  status?: number;
  /** An object is serialized; a string is served verbatim. */
  body?: unknown;
}

export type StubFetch = FetchLike & { calls: string[] };

/** A real ArrayBuffer (not a pooled Buffer slice), as fetch's arrayBuffer() promises. */
function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = Buffer.from(text);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/** A fetch stub: map of url -> {status?, body}. Every call is recorded on `.calls`. */
export function stubFetch(routes: Record<string, StubRoute>): StubFetch {
  const calls: string[] = [];
  const impl = async (url: string): Promise<FetchResponseLike> => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => toArrayBuffer(''),
      };
    }
    const status = hit.status || 200;
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      text: async () => body,
      json: async (): Promise<unknown> => JSON.parse(body),
      arrayBuffer: async () => toArrayBuffer(body),
    };
  };
  return Object.assign(impl, { calls });
}

/**
 * `lines` is both streams in the order they were written; `out` and `err` keep
 * them apart, so a test can hold --json stdout to the payload alone.
 */
export function silenceConsole(): {
  lines: string[];
  out: string[];
  err: string[];
  restore(): void;
} {
  const original = { log: console.log, error: console.error };
  const lines: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => {
    const line = a.join(' ');
    lines.push(line);
    out.push(line);
  };
  console.error = (...a: unknown[]) => {
    const line = a.join(' ');
    lines.push(line);
    err.push(line);
  };
  return {
    lines,
    out,
    err,
    restore() {
      console.log = original.log;
      console.error = original.error;
    },
  };
}

/**
 * A value with every path in it reduced to its string. `DirectoryPath` and
 * `FilePath` carry their platform's rules, and two objects holding the same
 * rules are not `deepEqual` - the bound functions inside differ - so an event
 * carrying a path is compared through the JSON form both sides agree on.
 */
export const plainly = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/**
 * An install outcome as one word - `installed`, `skipped`, or the failure's
 * message - so a harness test asserts it in one line and a failure says why
 * rather than just "not what I expected".
 */
export const outcome = <T>(result: Result<T, Failure>): T | string =>
  result.ok ? result.value : `failed: ${result.error.message}`;

/**
 * A `Failure`, thrown. Nothing in `src` throws for a problem the user can fix
 * any more - a command answers with an `ActionResult` and the router reads it -
 * but a few hundred assertions here are written as `assert.rejects`, and this
 * is what they catch.
 */
export class FailureError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = 'FailureError';
  }

  get hint(): string | undefined {
    return this.failure.hint;
  }
}

export const throwFailure = (failure: Failure): never => {
  throw new FailureError(failure);
};

/** A `Result`, unwrapped or thrown, for a test that only cares about the value. */
export function orThrow<T>(result: Result<T, Failure>): T {
  if (!result.ok) throw new FailureError(result.error);
  return result.value;
}

/** One brand and no ceremony: `readBrand` is the Result-returning seam in src. */
export const resolveBrand = (options: ResolveBrandOptions = {}): Brand =>
  orThrow(readBrand(options));

/**
 * A `ProcessRunner` whose spawn is a fake and whose lookup reads the env it was
 * given rather than the host's. The real `which` does the looking, so a PATH
 * stub keeps behaving exactly as it did when the two were separate arguments.
 */
export const runnerFor = (run: RunCommand, env: Env = {}): ProcessRunner => ({
  run,
  which: (cmd) => which(cmd, env),
});

/**
 * Complete ports for a test: the fake fetch it cares about, plus an env and a
 * runner. Required fields on `SourcePorts` mean a test has to say what it means
 * by "the environment" rather than inheriting the host's by omission - and the
 * runner spawns for real, so the tests that clone with git still clone.
 */
export const portsFor = (
  fetch: FetchLike,
  env: Env = {},
  run: RunCommand = realRun,
): SourcePorts => ({ fetch, env, runner: runnerFor(run, env) });

/**
 * Point the temp root somewhere a test can count, and put the environment back
 * afterwards - *back*, which for a variable that was not set means deleting it
 * rather than assigning `undefined`. `process.env.X = undefined` stores the
 * string `"undefined"`, and from then on `os.tmpdir()` answers with a directory
 * called `undefined` that does not exist, so every later test in that process
 * fails on `mkdtemp`.
 *
 * Not a theoretical case: Linux leaves `TMPDIR` unset where macOS and Windows
 * do not, so two tests that restored it by assignment poisoned the whole
 * process on the ubuntu matrix alone - and only once a test that came *after*
 * them wanted a temp directory. It went unnoticed because for a long time
 * nothing did.
 */
export function pinTempRoot(root: string): () => void {
  const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const key of keys) process.env[key] = root;
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
