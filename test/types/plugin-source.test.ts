import test from 'node:test';
import assert from 'node:assert';

import { rulesFor } from '../../src/types/file/paths.js';
import type { Failure } from '../../src/types/failure.js';
import { PluginId } from '../../src/types/ids/plugin-id.js';
import {
  GithubSource,
  LocalSource,
  MarketplaceSource,
  parseSource,
  restoreSource,
  sourceKindOf,
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

test('anything that is neither an id, a path nor a repo keeps the ids own failure', () => {
  // A typo reads as a typo. `acme/repo` used to be in this list and is a
  // source now, which is the one meaning phase 3 changed - and only for a
  // spelling that was refused outright before.
  for (const spec of ['Not An Id', 'UPPER', '', 'trailing-', undefined, 42]) {
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

test('only a plugin the marketplace lists lets its name leave the machine', () => {
  // A plugin installed from a path or a repository is named by its own author,
  // and a repository the user named is the same class of thing as the `--repo`
  // this program already refuses to send.
  assert.equal(value(parse('paypal')).reportableId()?.toString(), 'paypal');
  assert.equal(value(parse('./private-thing')).reportableId(), null);
  assert.equal(value(parse('acme/private-repo')).reportableId(), null);
});

const github = (spec: string): GithubSource => {
  const source = value(parse(spec));
  assert.ok(source instanceof GithubSource, `expected a github source for ${spec}`);
  return source;
};

const shape = (spec: string) => {
  const source = github(spec);
  return { repo: source.repo, ref: source.ref, path: source.path };
};

test('a bare owner/repo is a plugin in that repository, at the runs ref', () => {
  assert.deepEqual(shape('acme/my-plugin'), { repo: 'acme/my-plugin', ref: 'main', path: null });
});

test('a folder after the repo is a plugin inside it', () => {
  assert.deepEqual(shape('acme/mono/tools/foo'), {
    repo: 'acme/mono',
    ref: 'main',
    path: 'tools/foo',
  });
});

test('an inline ref wins over the runs, and may hold a slash', () => {
  assert.equal(shape('acme/my-plugin@v1.2').ref, 'v1.2');
  assert.equal(shape('acme/mono/tools/foo@v1.2').ref, 'v1.2');
  // Split at the last `@` rather than matched, because `release/1.0` is a
  // branch name a user will type and a single-segment pattern refuses it.
  assert.deepEqual(shape('acme/x@release/1.0'), {
    repo: 'acme/x',
    ref: 'release/1.0',
    path: null,
  });
});

test('the spellings github itself hands out all parse', () => {
  assert.deepEqual(shape('https://github.com/acme/mono/tree/v2/tools/foo'), {
    repo: 'acme/mono',
    ref: 'v2',
    path: 'tools/foo',
  });
  assert.deepEqual(shape('https://github.com/acme/x'), { repo: 'acme/x', ref: 'main', path: null });
  assert.deepEqual(shape('github.com/acme/x/'), { repo: 'acme/x', ref: 'main', path: null });
  assert.deepEqual(shape('https://www.github.com/acme/x.git'), {
    repo: 'acme/x',
    ref: 'main',
    path: null,
  });
  // What `git clone` prints, `.git` and all.
  assert.deepEqual(shape('git@github.com:acme/x.git'), { repo: 'acme/x', ref: 'main', path: null });
});

test('a path beats a repository, so a relative folder is never read as a slug', () => {
  // The reason `acme/repo` is a repository and `./acme/repo` is not: one of
  // the two spellings has to be the path, and a leading `.` is the one thing
  // no repository slug can start with.
  assert.equal(local('./acme/repo'), '/work/proj/acme/repo');
  assert.equal(value(parse('acme/repo')).kind, 'github');
});

test('a folder inside a repository is validated the way a ref and an id are', () => {
  // It reaches `git sparse-checkout add` as argv and a raw.githubusercontent
  // URL as a path, so the two things that change meaning there are refused
  // where they enter: a leading `-` reads as an option, and a `?` or `#`
  // truncates the URL - which would read some other file as the manifest.
  for (const spec of [
    'acme/mono/--upload-pack=evil',
    'acme/mono/-x',
    'acme/mono/a?b/c',
    'acme/mono/x#y',
    'acme/mono/a b',
    'acme/mono/tools/../../etc',
  ]) {
    const result = parse(spec);
    assert.equal(result.ok, false, `expected ${spec} to be refused`);
    if (!result.ok) assert.match(result.error.message, /is not a usable folder name/);
  }
  // And the ordinary spellings still pass.
  assert.equal(shape('acme/mono/tools/my-plugin.v2/_inner').path, 'tools/my-plugin.v2/_inner');
});

test('anything that is not a github repository says so, rather than talking about ids', () => {
  for (const spec of ['https://example.com/a/b', 'acme/', 'a c m e/repo']) {
    const result = parse(spec);
    assert.equal(result.ok, false, `expected ${spec} to be refused`);
    if (!result.ok) assert.match(result.error.message, /not a plugin id, a path, or a GitHub/);
  }
});

test('a ref the parser cannot pass to git is refused where it was written', () => {
  const result = parse('acme/x@--upload-pack=evil');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /Invalid ref/);
});

test('the manifest key keeps two plugins out of one repository apart', () => {
  assert.equal(github('acme/mono/tools/foo').key(), 'github:acme/mono//tools/foo');
  assert.equal(github('acme/mono/tools/bar').key(), 'github:acme/mono//tools/bar');
  assert.equal(github('acme/x').key(), 'github:acme/x');
  assert.notEqual(github('acme/x').key(), value(parse('paypal')).key());
});

test('a recorded key restores as the source it was written from', () => {
  for (const spec of ['paypal', 'acme/mono/tools/foo', 'acme/x', '/opt/x']) {
    const source = value(parse(spec));
    const back = restoreSource(source.key(), { plugin: new PluginId('my-sdk'), ref: 'main' });
    assert.equal(back.kind, source.kind, spec);
    assert.equal(back.key(), source.key(), spec);
  }
});

test('a key this build cannot read restores as a marketplace row, never as nothing', () => {
  // The invariant a row depends on: uninstall has to be able to reach every
  // row, so an odd-looking key is the oldest kind rather than an error.
  const odd = restoreSource('Acme/Weird-Repo', { plugin: new PluginId('my-sdk'), ref: 'main' });
  assert.equal(odd.kind, 'marketplace');
  assert.equal(odd.key(), 'Acme/Weird-Repo');
});

test('the kind of a recorded key is readable without building a source', () => {
  assert.equal(sourceKindOf('acme/plugin-marketplace'), 'marketplace');
  assert.equal(sourceKindOf('local:/opt/x'), 'local');
  assert.equal(sourceKindOf('github:acme/x'), 'github');
  assert.equal(sourceKindOf(undefined), 'marketplace');
});
