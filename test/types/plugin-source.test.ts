import test from 'node:test';
import assert from 'node:assert';

import { rulesFor } from '../../src/types/file/paths.js';
import type { Failure } from '../../src/types/failure.js';
import {
  LocalSource,
  MarketplaceSource,
  parseSource,
  type PluginSource,
} from '../../src/types/plugin-source.js';
import type { Result } from '../../src/types/result.js';

// The parser is pure and the whole point of it is which of two shapes an
// argument is, so it is asserted as a table over every spelling rather than
// through an install. Both platforms' rules are driven from here, which is what
// lets a Windows path be asserted from a Linux runner.

const POSIX = { cwd: '/work/proj', home: '/home/dev', rules: rulesFor('linux') };
const WIN = { cwd: 'C:\\work\\proj', home: 'C:\\Users\\dev', rules: rulesFor('win32') };
const MARKET = { repo: 'acme/plugin-marketplace', ref: 'main' };

const parse = (spec: unknown, over: Partial<typeof POSIX> = {}): Result<PluginSource, Failure> =>
  parseSource(spec, { ...MARKET, ...POSIX, ...over });

const value = (result: Result<PluginSource, Failure>): PluginSource => {
  assert.ok(result.ok, `expected a source, got: ${result.ok ? '' : result.error.message}`);
  return result.value;
};

const local = (spec: unknown, over: Partial<typeof POSIX> = {}): string => {
  const source = value(parse(spec, over));
  assert.ok(source instanceof LocalSource, `expected a local source for ${String(spec)}`);
  return source.dir.toString();
};

test('a kebab-case id is a marketplace source, and carries the runs repo and ref', () => {
  const source = value(parse('acme-payments'));
  assert.ok(source instanceof MarketplaceSource);
  assert.equal(source.plugin.toString(), 'acme-payments');
  assert.equal(source.repo, 'acme/plugin-marketplace');
  assert.equal(source.ref, 'main');
});

test('the id is tried first, so nothing this program already took changes meaning', () => {
  // The guarantee the ordering exists for: every spelling that worked before
  // still resolves to the marketplace arm and nothing else.
  for (const id of ['paypal', 'maxio', 'google-maps', 'a1', 'acme-payments-sdk']) {
    assert.equal(value(parse(id)).kind, 'marketplace', id);
  }
});

test('a relative path is a local source, resolved against the given cwd', () => {
  assert.equal(local('./my-plugin'), '/work/proj/my-plugin');
  assert.equal(local('../sibling/my-plugin'), '/work/sibling/my-plugin');
  assert.equal(local('.'), '/work/proj');
});

test('an absolute path is taken as it is', () => {
  assert.equal(local('/opt/plugins/my-plugin'), '/opt/plugins/my-plugin');
});

test('a tilde is expanded against the given home, not the real one', () => {
  assert.equal(local('~/dev/my-plugin'), '/home/dev/dev/my-plugin');
  assert.equal(local('~'), '/home/dev');
});

test('a name merely starting with a tilde is not a home path', () => {
  // `~plugin` has no separator after the tilde, so it is a directory called
  // `~plugin` in the cwd rather than something under the user's home.
  assert.equal(local('~plugin'), '/work/proj/~plugin');
});

test('windows paths resolve by windows rules, from any host', () => {
  assert.equal(local('.\\my-plugin', WIN), 'C:\\work\\proj\\my-plugin');
  assert.equal(local('C:\\dev\\my-plugin', WIN), 'C:\\dev\\my-plugin');
  assert.equal(local('c:/dev/my-plugin', WIN), 'c:\\dev\\my-plugin');
  assert.equal(local('~\\dev\\my-plugin', WIN), 'C:\\Users\\dev\\dev\\my-plugin');
  assert.equal(local('\\\\server\\share\\my-plugin', WIN), '\\\\server\\share\\my-plugin');
});

test('a path with spaces is a path, not a rejected id', () => {
  assert.equal(local('./my plugin'), '/work/proj/my plugin');
});

test('anything that is neither an id nor path-shaped keeps the ids own failure', () => {
  // Not a new message: a typo has always read as a typo, and phase 3 is what
  // teaches this parser that `acme/repo` is a source rather than a bad id.
  for (const spec of ['acme/repo', 'Not An Id', 'UPPER', '', 'trailing-', undefined, 42]) {
    const result = parse(spec);
    assert.equal(result.ok, false, `expected ${JSON.stringify(spec)} to be refused`);
    if (!result.ok) assert.match(result.error.message, /Invalid plugin id/);
  }
});

test('the manifest key is the repo for a marketplace source and prefixed for a local one', () => {
  assert.equal(value(parse('paypal')).key(), 'acme/plugin-marketplace');
  assert.equal(value(parse('/opt/x')).key(), 'local:/opt/x');
  // The prefix is what makes the two spaces disjoint: no slug can start `local:`.
  assert.notEqual(value(parse('/opt/x')).key(), value(parse('paypal')).key());
});

test('only a marketplace source lets its plugin id leave the machine', () => {
  assert.equal(value(parse('paypal')).reportableId()?.toString(), 'paypal');
  assert.equal(value(parse('./private-thing')).reportableId(), null);
});
