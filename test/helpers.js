'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = [];

function tmpDir(prefix = 'cp-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cleanupAll() {
  while (dirs.length) {
    try {
      fs.rmSync(dirs.pop(), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Minimal JSONC -> JSON so tests can assert that an edited settings.json is
 * still parseable. String-aware, so "https://x" and Windows paths survive.
 */
function parseJsonc(text) {
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

/** A fetch stub: map of url -> {status?, body} (body may be object or string). */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit)
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
        json: async () => ({}),
      };
    const status = hit.status || 200;
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      text: async () => body,
      json: async () => JSON.parse(body),
      arrayBuffer: async () => Buffer.from(body),
    };
  };
  impl.calls = calls;
  return impl;
}

function silenceConsole() {
  const original = { log: console.log, error: console.error };
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  return {
    lines,
    restore() {
      console.log = original.log;
      console.error = original.error;
    },
  };
}

module.exports = { tmpDir, cleanupAll, parseJsonc, stubFetch, silenceConsole };
