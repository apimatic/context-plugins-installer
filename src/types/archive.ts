import { REGISTRY_FILES } from './catalog.js';
import { Failure } from './failure.js';
import { MANIFEST_FILES } from './plugin-manifest.js';
import { err, ok, type Result } from './result.js';

// What an archive is allowed to be, as rules rather than as code that reads one:
// which extensions name an archive, which bytes prove it, what an entry may be
// called, and where inside it the plugin sits. Both readers ask this module, so
// the two of them cannot disagree - and every rule here is a table test, because
// none of it touches a file.

const MiB = 1024 * 1024;

/**
 * Two orders of magnitude above any real plugin. `unpacked` is checked against
 * what a zip's central directory declares, before a byte is inflated, and
 * against a running count while a tarball is decompressed.
 */
export const LIMITS = Object.freeze({
  bytes: 200 * MiB,
  unpacked: 1024 * MiB,
  entries: 50_000,
});

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';

/**
 * Longest first: `.tar.gz` and `.gz` would otherwise both match, and the wrong
 * one decides that a tarball is not an archive at all.
 */
const EXTENSIONS: readonly (readonly [string, ArchiveFormat])[] = Object.freeze([
  ['.tar.gz', 'tar.gz'],
  ['.tgz', 'tar.gz'],
  ['.zip', 'zip'],
  ['.tar', 'tar'],
]);

/** The spellings `formatOf` answers to, for the messages that list them. */
export const ARCHIVE_EXTENSIONS: readonly string[] = Object.freeze(EXTENSIONS.map(([ext]) => ext));

/**
 * The same four in prose, which is the only thing a message ever does with
 * them - so the list and the sentence that names it cannot drift apart.
 */
export const READABLE_FORMATS = `${ARCHIVE_EXTENSIONS.slice(0, -1).join(', ')} and ${
  ARCHIVE_EXTENSIONS[ARCHIVE_EXTENSIONS.length - 1] as string
}`;

/**
 * Archives and compressed files this program can name and cannot read. Asked
 * only once `formatOf` has answered no, which is what keeps `.gz` here from
 * shadowing `.tar.gz` - the readable spellings are always tried first. It
 * exists so a pasted `.7z` link is told what this tool reads rather than told
 * it is not a GitHub repository, which is true and no help at all.
 */
const UNREADABLE: readonly string[] = Object.freeze([
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
  '.zst',
  '.lz',
  '.lzma',
  '.gz',
  '.z',
  '.cab',
  '.iso',
  '.dmg',
]);

export function isUnreadableArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return UNREADABLE.some((ext) => lower.endsWith(ext));
}

/**
 * By extension, over a URL's pathname or a file's name: the question asked at
 * parse time, where there are no bytes to look at yet.
 */
export function formatOf(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  for (const [ext, format] of EXTENSIONS) {
    if (lower.endsWith(ext)) return format;
  }
  return null;
}

const startsWith = (head: Uint8Array, bytes: readonly number[]): boolean =>
  head.length >= bytes.length && bytes.every((b, i) => head[i] === b);

/**
 * By magic bytes, which overrule the extension. `fetch` transparently decodes a
 * `Content-Encoding: gzip`, so a `.tgz` served that way arrives as a bare tar -
 * a reader chosen by the file name would refuse a perfectly good archive. The
 * extension decides that an argument is an archive; the bytes decide how to
 * read it.
 */
export function sniff(head: Uint8Array): ArchiveFormat | null {
  // `PK\x03\x04` is an archive with entries, `PK\x05\x06` one with none, and
  // `PK\x07\x08` the first piece of a spanned one.
  if (startsWith(head, [0x50, 0x4b]) && [0x03, 0x05, 0x07].includes(head[2] ?? -1)) return 'zip';
  if (startsWith(head, [0x1f, 0x8b])) return 'tar.gz';
  // `ustar` at the offset a tar header keeps it. Compared byte by byte rather
  // than decoded, so that the bottom of the stack needs no Buffer.
  const USTAR = [0x75, 0x73, 0x74, 0x61, 0x72];
  if (head.length >= 262 && USTAR.every((b, i) => head[257 + i] === b)) return 'tar';
  return null;
}

/** Never a plugin's own files, wherever in an archive they appear. */
const IGNORED_ROOTS: readonly string[] = Object.freeze(['__MACOSX', '.git']);
const IGNORED_FILES: readonly string[] = Object.freeze(['.DS_Store']);

/**
 * A macOS Finder zip carries a `__MACOSX/` sibling of the folder it was made
 * from, which is what makes "exactly one top-level directory" false for the
 * most likely hand-made archive there is. `.git` follows `copyDir`, which has
 * always left a plugin's history behind.
 */
export function isIgnored(name: string): boolean {
  const segments = name.split('/');
  if (segments.some((s) => IGNORED_ROOTS.includes(s))) return true;
  const last = segments[segments.length - 1] ?? '';
  return IGNORED_FILES.includes(last);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const MAX_NAME = 4096;

/**
 * What to do with one entry's name. Three answers rather than two, because
 * "not a plugin's file" and "not a name this program will write" are different
 * findings: the first is ordinary and the second ends the archive.
 */
export type EntryName =
  { kind: 'write'; name: string } | { kind: 'ignore' } | { kind: 'refuse'; why: string };

/**
 * The rules an entry name has to pass, in this order - the order is the guard.
 * Normalising `\` has to happen **before** anything reads a segment, or
 * `..\..\x` walks straight out of the destination on Windows; and a name is
 * checked for having been seen before last, because two entries resolving to
 * one path is the trick where the manifest this program reads is not the file
 * the editor loads.
 *
 * Stateful only in that last rule, which is why it is a class: one instance
 * reads one archive.
 */
export class EntryNames {
  private readonly taken = new Set<string>();

  read(raw: string, isDirectory = false): EntryName {
    const refuse = (why: string): EntryName => ({ kind: 'refuse', why });
    if (!raw || raw.length > MAX_NAME) return refuse('an empty or absurdly long name');
    if (raw.includes('\0')) return refuse('a NUL byte in its name');

    // A zip written on Windows means `\` as a separator, and every other
    // extractor reads it that way.
    const name = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!name) return { kind: 'ignore' };
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return refuse('an absolute path');

    // `tar -czf x.tgz .` writes every name as `./...`; the segment says
    // nothing, so it is dropped rather than read as a climb the way `..` is.
    const segments = name.split('/').filter((segment) => segment !== '.');
    if (!segments.length) return { kind: 'ignore' };
    for (const segment of segments) {
      if (segment === '' || segment === '..') {
        return refuse('a path that climbs out of the archive');
      }
      if (segment.includes(':')) return refuse('a drive or stream separator in a name');
      if (/[. ]$/.test(segment)) return refuse('a name ending in a dot or a space');
      if (RESERVED.test(segment)) return refuse(`the reserved name '${segment}'`);
    }

    const cleaned = segments.join('/');
    if (isIgnored(cleaned)) return { kind: 'ignore' };
    // Only a file claims a name. A directory entry writes nothing - every
    // parent is made by the write that needs it - so two of them cannot be one
    // file, and refusing `Docs/` beside `docs/` ended an archive Linux is
    // entitled to hold over a collision that has no consequence. It defaults to
    // a file: a caller that says nothing gets the rule, not the exemption.
    if (isDirectory) return { kind: 'write', name: cleaned };
    // Folded, because on Windows and macOS `README` and `readme` are one file,
    // and the later entry would silently be the one both this program and the
    // editor read.
    const folded = cleaned.toLowerCase();
    if (this.taken.has(folded)) return refuse('the same name twice, in case or in spelling');
    this.taken.add(folded);
    return { kind: 'write', name: cleaned };
  }
}

/** Whether a name sits under a prefix, where `''` is the archive's own root. */
export const under = (name: string, prefix: string): boolean =>
  prefix === '' || name.startsWith(`${prefix}/`);

/** The part of `name` below `prefix`, for a name already known to be under it. */
export const relativeTo = (name: string, prefix: string): string =>
  prefix === '' ? name : name.slice(prefix.length + 1);

const directoriesUnder = (names: readonly string[], prefix: string): string[] => {
  const dirs = new Set<string>();
  for (const name of names) {
    if (!under(name, prefix)) continue;
    const rest = relativeTo(name, prefix);
    const cut = rest.indexOf('/');
    if (cut > 0) dirs.add(rest.slice(0, cut));
  }
  return [...dirs];
};

/** Files sitting directly at this level, which is what a wrapper has none of. */
const filesAt = (names: readonly string[], prefix: string): string[] =>
  names.filter((name) => under(name, prefix) && !relativeTo(name, prefix).includes('/'));

const hasAny = (names: readonly string[], prefix: string, files: readonly string[]): boolean =>
  files.some((file) => names.includes(prefix === '' ? file : `${prefix}/${file}`));

const join = (prefix: string, rest: string): string => (prefix === '' ? rest : `${prefix}/${rest}`);

/** A wrapper can wrap a wrapper; nothing legitimate nests deeper than this. */
const MAX_DESCENT = 16;

/** `pluginFolders`' answer for "the level you are already at holds one". */
const HERE = '.';

const listed = (names: readonly string[]): string =>
  names.length > 10 ? `${names.slice(0, 10).join(', ')}, ...` : names.join(', ');

/**
 * Every prefix on the way down, `''` first: an archive is unwrapped while its
 * current level holds no manifest and exactly one directory. The whole chain is
 * kept, not just its end, because a folder the user named is relative to
 * whichever of these levels they were looking at - and with nothing to stop it
 * at, the descent runs to the bottom of a manifest-less archive.
 */
function descent(names: readonly string[]): string[] {
  const chain = [''];
  for (let depth = 0; depth < MAX_DESCENT; depth++) {
    const root = chain[chain.length - 1] as string;
    if (hasAny(names, root, MANIFEST_FILES)) break;
    const dirs = directoriesUnder(names, root);
    // One directory and nothing beside it: that is a wrapper, and unwrapping
    // one is all this does. A level holding files of its own is a level the
    // archive's author put something at, so it is where the reading stops.
    if (dirs.length !== 1 || filesAt(names, root).length) break;
    chain.push(join(root, dirs[0] as string));
  }
  return chain;
}

/**
 * The folders under `root` that hold a plugin manifest, named the way the user
 * would type them after a `#`. A far better answer to "which folder did you
 * mean" than the immediate subdirectories, which are as often `.claude-plugin`
 * as anything worth naming.
 */
function pluginFolders(names: readonly string[], root: string): string[] {
  const found = new Set<string>();
  for (const name of names) {
    if (!under(name, root)) continue;
    const rest = relativeTo(name, root);
    // First match wins, which is why the probe order is longest-first: every
    // `.claude-plugin/plugin.json` also ends in `plugin.json`, and the loose
    // reading of it names the manifest's own folder as the plugin.
    for (const file of MANIFEST_FILES) {
      if (rest === file) {
        found.add(HERE);
        break;
      }
      if (rest.endsWith(`/${file}`)) {
        found.add(rest.slice(0, rest.length - file.length - 1));
        break;
      }
    }
  }
  return [...found];
}

/**
 * Which prefix inside an archive holds the plugin, over the entry names alone -
 * `''` for the archive's own root.
 *
 * Every archive GitHub builds is wrapped in one `<repo>-<ref>/` directory, so
 * descending into a lone folder is not a convenience: without it the common
 * case does not work at all. A `wanted` folder is resolved **under** that
 * wrapper first and at the literal root second, because the folder a user names
 * is the one they were reading on the page they copied the link from.
 */
export function pluginRoot(
  names: readonly string[],
  wanted: string | null,
  describe: string,
): Result<string, Failure> {
  if (!names.length) return err(new Failure(`${describe} is empty.`));

  const chain = descent(names);
  const root = chain[chain.length - 1] as string;
  const folders = (): string[] => pluginFolders(names, root);

  if (wanted !== null) {
    // Deepest first: when a name resolves at two levels, the wrapped one is the
    // tree the user was reading when they copied the link.
    const candidates = [...chain].reverse().map((prefix) => join(prefix, wanted));
    for (const prefix of candidates) {
      if (hasAny(names, prefix, MANIFEST_FILES)) return ok(prefix);
    }
    if (candidates.some((prefix) => names.some((name) => under(name, prefix)))) {
      return err(
        new Failure(
          `'${wanted}' in ${describe} has no plugin manifest.`,
          `Looked for ${MANIFEST_FILES.join(', ')} inside it.`,
        ),
      );
    }
    const holds = folders();
    const named = holds.filter((folder) => folder !== HERE);
    return err(
      new Failure(
        `'${wanted}' is not a folder in ${describe}.`,
        named.length
          ? `It holds ${listed(named)}.`
          : holds.length
            ? `Drop the # - the one plugin in ${describe} is found without it.`
            : `Nothing in it holds ${MANIFEST_FILES[0]}.`,
      ),
    );
  }

  if (hasAny(names, root, MANIFEST_FILES)) return ok(root);

  if (hasAny(names, root, REGISTRY_FILES)) {
    return err(
      new Failure(
        `${describe} is a marketplace, not a plugin.`,
        'Install one of its plugins by name, or point at the folder inside it that holds one.',
      ),
    );
  }
  const holds = folders();
  return err(
    new Failure(
      `${describe} does not look like a plugin.`,
      holds.length
        ? `No ${MANIFEST_FILES[0]} in it, but ${listed(holds)} holds one - name it after a # to install it.`
        : `No plugin manifest in it. Looked for ${MANIFEST_FILES.join(', ')}.`,
    ),
  );
}
