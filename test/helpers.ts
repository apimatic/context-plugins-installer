import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FetchLike, FetchResponseLike } from '../src/types.js';

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
