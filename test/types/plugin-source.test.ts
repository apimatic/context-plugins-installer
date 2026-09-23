import test from 'node:test';
import assert from 'node:assert';

import { rulesFor } from '../../src/types/file/paths.js';
import type { Failure } from '../../src/types/failure.js';
import { PluginId } from '../../src/types/ids/plugin-id.js';
import {
  ArchiveSource,
  GithubSource,
  LocalSource,
  MarketplaceSource,
  parseSource,
  restoreSource,
  sourceKindOf,
  type PluginSource,
} from '../../src/types/plugin-source.js';
import type { Result } from '../../src/types/result.js';

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
  for (const spec of ['Not An Id', 'UPPER', '', 'trailing-', undefined, 42]) {
    const result = parse(spec);
    assert.equal(result.ok, false, `expected ${JSON.stringify(spec)} to be refused`);
    if (!result.ok) assert.match(result.error.message, /Invalid plugin id/);
  }
});

test('the manifest key is the repo for a marketplace source and prefixed for a local one', () => {
  assert.equal(value(parse('paypal')).key(), 'acme/plugin-marketplace');
  assert.equal(value(parse('/opt/x')).key(), 'local:/opt/x');
  assert.notEqual(value(parse('/opt/x')).key(), value(parse('paypal')).key());
});

test('only a plugin the marketplace lists lets its name leave the machine', () => {
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
  assert.deepEqual(shape('git@github.com:acme/x.git'), { repo: 'acme/x', ref: 'main', path: null });
  assert.equal(shape('github.com/acme/mono/tools/foo').path, 'tools/foo');
});

test('an inline ref reaches every remote spelling, not only the shorthand', () => {
  for (const spec of [
    'https://github.com/acme/x@v1.2.0',
    'github.com/acme/x@v1.2.0',
    'https://www.github.com/acme/x.git@v1.2.0',
    'git@github.com:acme/x.git@v1.2.0',
    'ssh://git@github.com/acme/x@v1.2.0',
  ]) {
    assert.deepEqual(shape(spec), { repo: 'acme/x', ref: 'v1.2.0', path: null }, spec);
  }
  assert.equal(shape('https://github.com/acme/x@release/1.0').ref, 'release/1.0');
});

test('a ref written by hand wins over the one in the URL it was appended to', () => {
  assert.deepEqual(shape('https://github.com/acme/mono/tree/main/tools/foo@v2'), {
    repo: 'acme/mono',
    ref: 'v2',
    path: 'tools/foo',
  });
});

test('a link to a file says so, rather than reading github view words as a folder', () => {
  for (const spec of [
    'https://github.com/acme/mono/blob/main/tools/foo',
    'https://github.com/acme/mono/blob/main/tools/foo/.claude-plugin/plugin.json',
    'https://github.com/acme/mono/raw/main/x',
    'https://github.com/acme/mono/blame/main/x',
    'https://github.com/acme/mono/edit/main/x',
  ]) {
    const result = parse(spec);
    assert.equal(result.ok, false, `expected ${spec} to be refused`);
    if (!result.ok) assert.match(result.error.message, /is a link to a file/);
  }
});

test('a github.com page is refused by name, not carried as a folder that is not there', () => {
  for (const spec of [
    'https://github.com/acme/mono/issues/12',
    'https://github.com/acme/mono/pull/7',
    'https://github.com/acme/mono/releases/tag/v1',
    'https://github.com/acme/mono/actions',
    'https://github.com/acme/mono/tree',
  ]) {
    const result = parse(spec);
    assert.equal(result.ok, false, `expected ${spec} to be refused`);
    if (!result.ok) assert.match(result.error.message, /is a github\.com view/);
  }
  // Only a URL carries views, so the shorthand still names a folder whatever it is called.
  assert.equal(shape('acme/mono/blob').path, 'blob');
  assert.equal(shape('acme/mono/issues/12').path, 'issues/12');
});

test('a page word a monorepo also uses for its folders is left as a folder', () => {
  // `packages` and `projects` are pages on github.com and the two commonest names
  // for the folder a monorepo keeps its plugins in. The folder wins.
  assert.equal(shape('github.com/acme/mono/packages/my-plugin').path, 'packages/my-plugin');
  assert.equal(shape('acme/mono/packages/my-plugin').path, 'packages/my-plugin');
  assert.equal(shape('https://github.com/acme/mono/tree/v2/projects/x').path, 'projects/x');
});

test('a path beats a repository, so a relative folder is never read as a slug', () => {
  assert.equal(local('./acme/repo'), '/work/proj/acme/repo');
  assert.equal(value(parse('acme/repo')).kind, 'github');
});

test('a folder inside a repository is validated the way a ref and an id are', () => {
  // The folder reaches `git sparse-checkout add` as argv and a
  // raw.githubusercontent URL as a path: `-` reads as an option, `?`/`#` truncate.
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

const archive = (spec: unknown, over: Partial<typeof POSIX> = {}): ArchiveSource => {
  const source = value(parse(spec, over));
  assert.ok(source instanceof ArchiveSource, `expected an archive for ${String(spec)}`);
  return source;
};

test('an https URL ending in an archive extension is an archive', () => {
  for (const [spec, url] of [
    ['https://acme.com/my-plugin.zip', 'https://acme.com/my-plugin.zip'],
    ['https://acme.com/my-plugin.tar.gz', 'https://acme.com/my-plugin.tar.gz'],
    ['https://acme.com/my-plugin.tgz', 'https://acme.com/my-plugin.tgz'],
    // The extension is read off the URL's path, so a presigned link - the only
    // way a private archive is installable here - still names one.
    [
      'https://acme.com/dl/p.zip?X-Amz-Signature=abc',
      'https://acme.com/dl/p.zip?X-Amz-Signature=abc',
    ],
    // Both of github.com's own archive links, neither of which is a repository.
    [
      'https://github.com/acme/x/releases/download/v1/p.zip',
      'https://github.com/acme/x/releases/download/v1/p.zip',
    ],
    [
      'https://github.com/acme/mono/archive/refs/heads/main.tar.gz',
      'https://github.com/acme/mono/archive/refs/heads/main.tar.gz',
    ],
  ] as const) {
    const source = archive(spec);
    assert.deepEqual(source.at, { kind: 'url', url }, spec);
    assert.equal(source.path, null, spec);
  }
});

test('a folder inside an archive is the fragment, split at the last #', () => {
  const source = archive('https://acme.com/mono.zip#tools/foo');
  assert.equal(source.location(), 'https://acme.com/mono.zip');
  assert.equal(source.path, 'tools/foo');
  assert.equal(source.key(), 'archive:https://acme.com/mono.zip#tools/foo');
});

test('a # that is part of a name is not a fragment', () => {
  // The rule is the same shape as the @ref split: what precedes it has to be
  // the thing the separator belongs to.
  const source = archive('./my#plugin.zip');
  assert.equal(source.path, null);
  assert.deepEqual(source.at, {
    kind: 'file',
    file: source.at.kind === 'file' ? source.at.file : null,
  });
  assert.match(source.location(), /my#plugin\.zip$/);
});

test('an archive has no ref, so an @ in its name stays in its name', () => {
  const source = archive('https://acme.com/p@2.zip');
  assert.equal(source.location(), 'https://acme.com/p@2.zip');
});

test('an archive on this machine is resolved against the cwd, and the home is expanded', () => {
  assert.equal(archive('./my-plugin.zip').location(), '/work/proj/my-plugin.zip');
  assert.equal(archive('~/dl/my-plugin.tgz').location(), '/home/dev/dl/my-plugin.tgz');
  assert.equal(archive('C:\\dl\\my-plugin.zip', WIN).location(), 'C:\\dl\\my-plugin.zip');
});

test('http is refused where it is written, and says why', () => {
  const result = parse('http://acme.com/my-plugin.zip');
  assert.ok(!result.ok);
  assert.match(result.error.message, /is not an https URL/);
  assert.match(result.error.hint ?? '', /hooks/);
});

test('a bare file name is told how to be a path, rather than failing as a bad id', () => {
  const result = parse('my-plugin.zip');
  assert.ok(!result.ok);
  assert.match(result.error.message, /is a file name, not a plugin id/);
  assert.match(result.error.hint ?? '', /\.\/my-plugin\.zip/);
  // With a folder too: still a file name, still the same hint.
  const inside = parse('mono.tar.gz#tools/foo');
  assert.ok(!inside.ok);
  assert.match(inside.error.hint ?? '', /\.\/mono\.tar\.gz#tools\/foo/);
});

test('only a URL or a path can be an archive, so a repository named like one is not', () => {
  const source = value(parse('acme/my-plugin.zip'));
  assert.ok(source instanceof GithubSource, 'a repo whose name ends in .zip is still a repo');
  assert.equal(source.repo, 'acme/my-plugin.zip');
});

test('a URL that names no archive is still read as a repository, and fails as one', () => {
  const result = parse('https://acme.com/my-plugin');
  assert.ok(!result.ok);
  assert.match(result.error.message, /not a plugin id, a path, or a GitHub repository/);
});

test('a folder inside an archive is validated the way a repositorys is', () => {
  for (const bad of ['..', 'a/../b', '-flag']) {
    const result = parse(`https://acme.com/mono.zip#${bad}`);
    assert.ok(!result.ok, bad);
    assert.match(result.error.message, /not a usable folder name/, bad);
  }
});

test('a recorded key restores as the source it was written from', () => {
  for (const spec of [
    'paypal',
    'acme/mono/tools/foo',
    'acme/x',
    '/opt/x',
    'https://acme.com/p.zip',
    'https://acme.com/mono.zip#tools/foo',
    '/opt/my-plugin.tar.gz',
  ]) {
    const source = value(parse(spec));
    const back = restoreSource(source.key(), { plugin: new PluginId('my-sdk'), ref: 'main' });
    assert.equal(back.kind, source.kind, spec);
    assert.equal(back.key(), source.key(), spec);
  }
});

test('a key this build cannot read restores as a marketplace row, never as nothing', () => {
  const odd = restoreSource('Acme/Weird-Repo', { plugin: new PluginId('my-sdk'), ref: 'main' });
  assert.equal(odd.kind, 'marketplace');
  assert.equal(odd.key(), 'Acme/Weird-Repo');
});

test('the kind of a recorded key is readable without building a source', () => {
  assert.equal(sourceKindOf('acme/plugin-marketplace'), 'marketplace');
  assert.equal(sourceKindOf('local:/opt/x'), 'local');
  assert.equal(sourceKindOf('github:acme/x'), 'github');
  assert.equal(sourceKindOf('archive:https://acme.com/p.zip'), 'archive');
  assert.equal(sourceKindOf(undefined), 'marketplace');
});
