import test from 'node:test';
import assert from 'node:assert';

import {
  EntryNames,
  LIMITS,
  formatOf,
  isIgnored,
  pluginRoot,
  relativeTo,
  sniff,
} from '../../src/types/archive.js';

// The whole policy an archive is read under, with no archive in sight: which
// extensions name one, which bytes prove it, what an entry may be called, and
// where inside it the plugin sits.

const MANIFEST = '.claude-plugin/plugin.json';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

const at = (offset: number, ...values: number[]): Uint8Array => {
  const out = new Uint8Array(offset + values.length);
  out.set(values, offset);
  return out;
};

test('an extension names a format, longest first', () => {
  assert.equal(formatOf('my-plugin.zip'), 'zip');
  assert.equal(formatOf('my-plugin.tar.gz'), 'tar.gz');
  assert.equal(formatOf('my-plugin.tgz'), 'tar.gz');
  assert.equal(formatOf('my-plugin.tar'), 'tar');
  // `.gz` alone must not win, or every tarball stops being an archive.
  assert.equal(formatOf('/dl/PLUGIN.TAR.GZ'), 'tar.gz');
  assert.equal(formatOf('my-plugin.zip.txt'), null);
  assert.equal(formatOf('my-plugin'), null);
  assert.equal(formatOf(''), null);
});

test('the bytes decide the reader, whatever the name said', () => {
  assert.equal(sniff(bytes(0x50, 0x4b, 0x03, 0x04)), 'zip');
  assert.equal(sniff(bytes(0x50, 0x4b, 0x05, 0x06)), 'zip', 'an empty zip is still a zip');
  assert.equal(sniff(bytes(0x50, 0x4b, 0x07, 0x08)), 'zip');
  assert.equal(sniff(bytes(0x1f, 0x8b, 0x08, 0x00)), 'tar.gz');
  // A `.tgz` served with Content-Encoding: gzip arrives decoded, as a bare tar.
  assert.equal(sniff(at(257, 0x75, 0x73, 0x74, 0x61, 0x72)), 'tar');
  assert.equal(sniff(bytes(0x3c, 0x21, 0x44, 0x4f)), null, 'an HTML error page is not an archive');
  assert.equal(sniff(bytes(0x50)), null, 'and neither is a truncated one');
  assert.equal(sniff(bytes()), null);
});

test('a name that climbs out of the archive is refused, in either spelling', () => {
  const names = new EntryNames();
  for (const raw of ['../escape.txt', 'a/../../escape.txt', '..\\..\\escape.txt']) {
    const read = names.read(raw);
    assert.equal(read.kind, 'refuse', raw);
    assert.match(read.kind === 'refuse' ? read.why : '', /climbs out/);
  }
});

test('the backslash is a separator before it is anything else', () => {
  // Read in the other order, `..\..\x` is one innocent-looking segment.
  const read = new EntryNames().read('plugin\\skills\\SKILL.md');
  assert.deepEqual(read, { kind: 'write', name: 'plugin/skills/SKILL.md' });
});

test('an absolute name is refused, drive letter or not', () => {
  for (const raw of ['/etc/cron.d/x', 'C:/Windows/x', 'C:\\Windows\\x']) {
    assert.equal(new EntryNames().read(raw).kind, 'refuse', raw);
  }
});

test('a name Windows cannot hold is refused wherever the archive is opened', () => {
  for (const raw of ['CON', 'nul.md', 'a/COM1.txt', 'a/b:stream', 'trailing.', 'space ']) {
    const read = new EntryNames().read(raw);
    assert.equal(read.kind, 'refuse', raw);
  }
  assert.equal(new EntryNames().read('console.js').kind, 'write', 'but a longer name is fine');
});

test('an empty, absurd or NUL-carrying name is refused', () => {
  const names = new EntryNames();
  assert.equal(names.read('').kind, 'refuse');
  assert.equal(names.read('a\0b').kind, 'refuse');
  assert.equal(names.read('x'.repeat(5000)).kind, 'refuse');
});

test('the same name twice is refused, because one of them is not what gets read', () => {
  const names = new EntryNames();
  assert.equal(names.read(MANIFEST).kind, 'write');
  const again = names.read(MANIFEST);
  assert.equal(again.kind, 'refuse');
  assert.match(again.kind === 'refuse' ? again.why : '', /twice/);
  // And after normalising, `a/b` and `a\b` are that case.
  const both = new EntryNames();
  assert.equal(both.read('a/b').kind, 'write');
  assert.equal(both.read('a\\b').kind, 'refuse');
});

test('what is never a plugins own file is ignored rather than refused', () => {
  const names = new EntryNames();
  for (const raw of ['__MACOSX/my-plugin/._x', '.git/config', 'a/.git/HEAD', 'skills/.DS_Store']) {
    assert.equal(names.read(raw).kind, 'ignore', raw);
  }
  assert.ok(isIgnored('__MACOSX/x'));
  assert.ok(!isIgnored('my-plugin/skills/SKILL.md'));
});

test('a directory entry is a name without its trailing slash, and the root entry is nothing', () => {
  const names = new EntryNames();
  assert.deepEqual(names.read('hooks/'), { kind: 'write', name: 'hooks' });
  assert.equal(names.read('/').kind, 'ignore', 'an entry naming the root writes nothing');
});

test('a leading ./ says nothing and is dropped, the way tar writes it', () => {
  const names = new EntryNames();
  assert.equal(names.read('./').kind, 'ignore', 'the current directory is the root');
  assert.deepEqual(names.read('./skills/SKILL.md'), { kind: 'write', name: 'skills/SKILL.md' });
  assert.deepEqual(names.read('a/./b'), { kind: 'write', name: 'a/b' });
  // Dropping `.` must not make `..` any more welcome.
  assert.equal(names.read('./../x').kind, 'refuse');
});

test('a directory claims no name, because it writes none', () => {
  const names = new EntryNames();
  // Linux is entitled to both, and neither writes anything - every parent is
  // made by the write that needs it - so neither can be the other's file.
  assert.deepEqual(names.read('Docs/', true), { kind: 'write', name: 'Docs' });
  assert.deepEqual(names.read('docs/', true), { kind: 'write', name: 'docs' });
  // The rule still holds for what is inside them, which does write.
  assert.equal(names.read('Docs/a.md').kind, 'write');
  assert.equal(names.read('docs/A.md').kind, 'refuse');
});

test('two names that differ only in case are one file on half the machines, so they are refused', () => {
  const names = new EntryNames();
  assert.equal(names.read('README.md').kind, 'write');
  const again = names.read('readme.md');
  assert.equal(again.kind, 'refuse');
  assert.match(again.kind === 'refuse' ? again.why : '', /twice/);
});

test('the root of an unwrapped archive is the archive itself', () => {
  const found = pluginRoot([MANIFEST, 'skills/SKILL.md'], null, 'p.zip');
  assert.deepEqual(found, { ok: true, value: '' });
});

test('a single wrapping folder is descended, however many deep', () => {
  const one = pluginRoot([`repo-main/${MANIFEST}`, 'repo-main/skills/SKILL.md'], null, 'p.zip');
  assert.ok(one.ok && one.value === 'repo-main');

  const two = pluginRoot([`a/b/${MANIFEST}`], null, 'p.zip');
  assert.ok(two.ok && two.value === 'a/b');
});

test('a manifest at the root wins over descending past it', () => {
  const found = pluginRoot([MANIFEST, `sub/${MANIFEST}`], null, 'p.zip');
  assert.ok(found.ok && found.value === '');
});

test('a macOS sibling does not make an archive multi-rooted', () => {
  // Every Finder zip carries one of these, so this is the common case.
  const names = new EntryNames();
  const raw = [`my-plugin/${MANIFEST}`, 'my-plugin/skills/SKILL.md', '__MACOSX/my-plugin/._x'];
  const kept = raw.map((n) => names.read(n)).flatMap((r) => (r.kind === 'write' ? [r.name] : []));
  const found = pluginRoot(kept, null, 'p.zip');
  assert.ok(found.ok && found.value === 'my-plugin');
});

test('the tree is read from the file names, because directory entries are optional', () => {
  // Compress-Archive writes none at all.
  const found = pluginRoot([`my-plugin/${MANIFEST}`], null, 'p.zip');
  assert.ok(found.ok && found.value === 'my-plugin');
});

test('a marketplace is named as one rather than reported as no plugin', () => {
  const found = pluginRoot(
    ['m-main/.claude-plugin/marketplace.json', `m-main/plugins/slack/${MANIFEST}`],
    null,
    'm.zip',
  );
  assert.ok(!found.ok);
  assert.match(found.error.message, /is a marketplace, not a plugin/);
});

test('an empty archive says so', () => {
  const found = pluginRoot([], null, 'p.zip');
  assert.ok(!found.ok);
  assert.match(found.error.message, /is empty/);
});

test('a named folder is resolved under the wrapper first', () => {
  // The case every GitHub archive link is: the user types what the page showed
  // them, and the wrapper is not on the page.
  const names = [`m-main/plugins/slack/${MANIFEST}`, 'm-main/.claude-plugin/marketplace.json'];
  const found = pluginRoot(names, 'plugins/slack', 'm.zip');
  assert.ok(found.ok && found.value === 'm-main/plugins/slack');
});

test('a named folder is resolved at the literal root when there is no wrapper', () => {
  const found = pluginRoot([`plugins/slack/${MANIFEST}`, 'README.md'], 'plugins/slack', 'm.zip');
  assert.ok(found.ok && found.value === 'plugins/slack');
});

test('when both hold a manifest the wrapped one wins', () => {
  const names = [`tools/a/${MANIFEST}`, `wrap/tools/a/${MANIFEST}`, 'wrap/README.md'];
  // `wrap` is not the only top-level directory here, so nothing is descended:
  // the literal root answers. Descent and the fragment are separate questions.
  const found = pluginRoot(names, 'tools/a', 'm.zip');
  assert.ok(found.ok && found.value === 'tools/a');

  const wrapped = pluginRoot(
    [`wrap/tools/a/${MANIFEST}`, `wrap/tools/a/x`, 'wrap/README.md'],
    'tools/a',
    'm.zip',
  );
  assert.ok(wrapped.ok && wrapped.value === 'wrap/tools/a');
});

test('a named folder that is there but holds no plugin says which of the two it is', () => {
  const found = pluginRoot([`m-main/plugins/slack/README.md`], 'plugins/slack', 'm.zip');
  assert.ok(!found.ok);
  assert.match(found.error.message, /has no plugin manifest/);
});

test('a named folder that is not there lists the ones that hold a plugin', () => {
  const found = pluginRoot(
    [`m-main/plugins/slack/${MANIFEST}`, `m-main/plugins/teams/${MANIFEST}`],
    'plugins/discord',
    'm.zip',
  );
  assert.ok(!found.ok);
  assert.match(found.error.message, /is not a folder in m\.zip/);
  // The folders that hold one, not the subdirectories - which are as often
  // `.claude-plugin` as anything worth naming.
  assert.match(found.error.hint ?? '', /slack/);
  assert.match(found.error.hint ?? '', /teams/);
});

test('a fragment on an archive that holds exactly one plugin says to drop it', () => {
  const found = pluginRoot([`my-plugin/${MANIFEST}`], 'tools/foo', 'p.zip');
  assert.ok(!found.ok);
  assert.match(found.error.hint ?? '', /Drop the #/);
});

test('several plugins and no wrapper is a failure that names each of them', () => {
  // `tools` is the only directory here, but the level holds a file of its own,
  // so nothing is unwrapped - which is why these are named from the root.
  const found = pluginRoot(
    [`tools/a/${MANIFEST}`, `tools/b/${MANIFEST}`, 'README.md'],
    null,
    'p.zip',
  );
  assert.ok(!found.ok);
  assert.match(found.error.message, /p\.zip does not look like a plugin/);
  assert.match(found.error.hint ?? '', /tools\/a/);
  assert.match(found.error.hint ?? '', /tools\/b/);
  assert.match(found.error.hint ?? '', /after a #/);
});

test('a relative name is the part below the prefix, root or not', () => {
  assert.equal(relativeTo('a/b/c', 'a/b'), 'c');
  assert.equal(relativeTo('a/b/c', ''), 'a/b/c');
});

test('the limits are the ones the plan settled on', () => {
  assert.equal(LIMITS.bytes, 200 * 1024 * 1024);
  assert.equal(LIMITS.unpacked, 1024 * 1024 * 1024);
  assert.equal(LIMITS.entries, 50_000);
});
