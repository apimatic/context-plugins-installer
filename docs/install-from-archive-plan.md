# context-plugins Install-from-Archive Plan

Teaching `install` a fourth origin - a `.zip` or `.tar.gz` that is itself a plugin, at an
https URL or on this machine - without a new flag, without a dependency, and without
changing what a marketplace, a path or a repository install does today.

The reader is the whole feature. Everything after it is the path install that already
works: an archive is extracted into a temporary directory and handed to the same plugin
read, the same generated marketplace, the same harnesses. So this plan is mostly about
what a stranger's archive is allowed to do to the machine that opens it.

| Date       | Base             | Measured on | Scope                                     |
| ---------- | ---------------- | ----------- | ----------------------------------------- |
| 2026-09-23 | `main @ 1caef85` | Node 23.4.0 | `install`, `uninstall`, `update`, records |

Every measurement below was taken on Node 23.4.0 against real archives. **Nothing here has
been run on Node 18**, which is the engine floor: the one Node 18 fact this plan turns on
(`zlib.crc32` does not exist there) comes from the changelog, and the CI matrix is what
will confirm the rest. Revised 2026-09-23 after an adversarial review; the changes are
listed in [What the review changed](#what-the-review-changed).

Contents

1. [Decisions already made](#decisions-already-made)
2. [What the research found](#what-the-research-found)
3. [What the user types](#what-the-user-types)
4. [The model](#the-model)
5. [Finding the plugin inside](#finding-the-plugin-inside)
6. [Reading an archive](#reading-an-archive)
7. [Where the fork lands](#where-the-fork-lands)
8. [Trust moves ahead of resolve](#trust-moves-ahead-of-resolve)
9. [State: one key, four origins](#state-one-key-four-origins)
10. [Per command](#per-command)
11. [Telemetry](#telemetry)
12. [Guards](#guards)
13. [File map](#file-map)
14. [Test map](#test-map)
15. [Phases](#phases)
16. [Open items](#open-items)
17. [Out of scope](#out-of-scope)
18. [What the review changed](#what-the-review-changed)

## Decisions already made

Settled before the plan was written. Everything below assumes them; change one and the
phase that carries it changes with it.

| Decision  | Choice                                         | Why                                                                                                                             |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Surface   | Positional, by extension only                  | A URL is an archive iff its **path** ends `.zip`, `.tar.gz`, `.tgz` or `.tar`. No flag, no content sniffing at parse time.      |
| Formats   | zip and gzipped tar                            | Between them they cover release assets, `archive/` links, `npm pack` and `Compress-Archive`.                                    |
| On disk   | A local archive file installs too              | Same reader, one extra branch. It is also the answer for a private URL, which this tool will not authenticate.                  |
| Inside    | Auto-descend, plus a `#folder` fragment        | Every GitHub archive is wrapped in `<repo>-<ref>/`, so auto-descend is what makes the common case work at all.                  |
| Transport | https only, at every hop                       | A plugin runs commands through its hooks. There is no signature to fall back on, so the channel is the only integrity there is. |
| Auth      | No credential, ever, to any host               | A token sent to a host the user mistyped is worse than a plugin that cannot be installed.                                       |
| Integrity | None beyond the transport                      | A URL is as mutable as a branch, which `--ref main` already is. Recording a digest is a later feature, not a smaller one.       |
| Limits    | 200 MB download, 1 GB unpacked, 50,000 entries | Two orders of magnitude above any real plugin, and below anything that costs the machine.                                       |
| Trust     | Confirm once, before the download              | Existing rule, honoured literally - see [Trust moves ahead of resolve](#trust-moves-ahead-of-resolve).                          |

## What the research found

A prototype reader was written and run against real archives before any of this was
designed, because several of the decisions below only make sense once the measurements are
on the table.

| Question                                          | Measured                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a zip be read with no dependency?             | Yes. Central directory + `zlib.inflateRawSync`, ~200 lines. Read 189/189 entries of a GitHub zipball, every CRC matching.                                                                                                                                                              |
| Is there a CRC32 in the standard library?         | `zlib.crc32` exists, but landed in Node 20.15. **Node 18 is the floor**, so the table is hand-rolled - 15 lines, and the third hand-rolled primitive here after `which()` and `pool()`.                                                                                                |
| Can a tarball be read with no dependency?         | Yes. 512-byte ustar headers + `zlib.gunzip`, ~150 lines, including the PAX `path=` record GitHub writes and GNU `L` long names. 230/230 entries of a GitHub tarball.                                                                                                                   |
| Can a zip bomb be refused cheaply?                | Yes, and this is the good news of the whole exercise: **a zip's central directory declares every uncompressed size up front**, so the cap is arithmetic over a list, before a byte is inflated. A 51 KB / 50 MB sample (1000:1) is refused without decompressing it.                   |
| And a lying central directory?                    | `inflateRawSync(raw, { maxOutputLength: declared })` throws `ERR_BUFFER_TOO_LARGE` - verified. A tarball has no such manifest, so its cap is a running count over the gunzip output.                                                                                                   |
| Does `content-length` bound the download?         | **No.** `codeload.github.com` answers chunked, with no `content-length` at all. The cap has to be counted while the bytes arrive, which is why `FetchResponseLike` grows a body.                                                                                                       |
| Is the response body streamable through the port? | Yes. `res.body` is a `ReadableStream` and async-iterable, and `body.cancel()` stops a download that has gone past the cap. Typed as `AsyncIterable<Uint8Array>` it compiles against the pinned `@types/node@18` - verified against this repo's own tsconfig.                           |
| Do redirects stay on https?                       | Not by themselves. `redirect: 'manual'` returns the real 302 **with its `Location` header** in Node (unlike a browser's opaque redirect), so following the chain by hand is what makes "https at every hop" enforceable. A GitHub `archive/` link is one hop.                          |
| Does the extension say which reader to use?       | **No.** `fetch` transparently decodes `Content-Encoding: gzip`, so a `.tgz` served with that header arrives as a _bare tar_. The magic bytes decide the reader; the extension only decides that the argument is an archive at all.                                                     |
| Are directory entries present?                    | **Not always.** `Compress-Archive` wrote three file entries and no directory entries at all; `git archive` and GitHub write them. Anything that reasons about the shape of the tree has to do it from the file names.                                                                  |
| Do archives carry the executable bit?             | A tarball does - GitHub's carries `0664`/`0775` throughout. A **GitHub zipball does not**: every entry is host-OS 0 (FAT) with a zero mode, as is anything `Compress-Archive` writes. A plugin whose hooks are shell scripts keeps `+x` through `.tar.gz` and loses it through `.zip`. |
| Where is the plugin inside a GitHub archive?      | Under a single top-level `"<repo>-<ref>/"` wrapper, in both formats - measured again on `context-plugins/plugin-marketplace`, whose slack plugin sits at `plugin-marketplace-main/plugins/slack/`. Auto-descend is not a convenience; without it the common case does not work.        |
| Does `Compress-Archive` write backslashes?        | Not on 5.1.26100 or 7.6 - both write `/`. Older 5.1 builds are widely reported to write `\`, and it costs one line to treat `\` as a separator, so the reader does.                                                                                                                    |
| Do the nasty entry names round-trip?              | Yes: `../escape.txt`, `/abs.txt`, `C:\win.txt` and a symlink entry all survive a write/read cycle in both formats and arrive at the extractor verbatim. They are the guard's whole job.                                                                                                |
| Zip64?                                            | Parsed - the locator, the record, and the per-entry extra field. Python's `force_zip64` archives read correctly. No plugin needs it; a writer that emits it anyway is not a reason to fail.                                                                                            |

Peak cost of the design below: one temp file the size of the download, one the size of the
unpacked tar, and one entry in memory at a time. Nothing holds the archive in memory.

## What the user types

`args.ts` is untouched. The parse order gains one step, and it goes **before** the GitHub
arm, which is what lets a github.com URL that names an archive be one.

| Argument                                                      | Kind      | Reader   | Files                                                                      |
| ------------------------------------------------------------- | --------- | -------- | -------------------------------------------------------------------------- |
| `https://acme.com/my-plugin.zip`                              | archive   | zip      | the archive's root, or its one folder                                      |
| `https://acme.com/my-plugin.tar.gz`                           | archive   | tar      | as above                                                                   |
| `https://acme.com/p.zip?X-Amz-Signature=...`                  | archive   | zip      | a presigned URL - the query is ignored by the rule and kept in the request |
| `https://github.com/acme/x/releases/download/v1/plugin.zip`   | archive   | zip      | a release asset - refused today                                            |
| `https://github.com/acme/mono/archive/refs/heads/main.tar.gz` | archive   | tar      | descends `mono-main/`                                                      |
| `https://acme.com/mono.zip#tools/foo`                         | archive   | zip      | `tools/foo`, under the wrapper if there is one                             |
| `./my-plugin.zip`, `~/Downloads/x.tgz`, `C:\dl\x.tar.gz`      | archive   | by magic | a file on this machine                                                     |
| `http://acme.com/my-plugin.zip`                               | -         | -        | refused at parse time, naming https                                        |
| `acme/my-plugin.zip`                                          | github    | -        | unchanged: only a URL can be an archive                                    |
| `./my-plugin`, `acme/my-plugin`, `paypal`                     | unchanged | -        | unchanged                                                                  |

Four rules make that table unambiguous, and each is the answer to a spelling that would
otherwise mean two things:

- **The URL's path, not the whole string.** `new URL(spec).pathname` is what the extension
  is read off - a global, needing no import, so `types/` stays as pure as it is. That is
  what admits `p.zip?X-Amz-Signature=...`, and a presigned URL matters more here than it
  looks: this tool sends no credential of its own, so a presigned link is the only way a
  private archive is installable at all.
- **Extension, not scheme.** An https URL whose path does not end in an archive extension
  is still read as a GitHub repository, and still fails `notARepo` when it is not one -
  with that failure's hint extended to name the archive extensions, since "it must be a
  repo or a path" is now missing a case.
- **No `@ref` on an archive.** The archive arm runs before `parseGithub`, so the `@` in
  `https://acme.com/p@2.zip` is part of the name. An archive has no ref; `report.ref` is
  `null`, the way a directory's is, and a `--ref` given alongside one is reported through
  the existing `refIgnored` line rather than silently dropped.
- **The `#` splits only when the left side is an archive.** Split at the **last** `#`, and
  only if what precedes it ends in an archive extension. `./my#plugin.zip` is therefore a
  file called `my#plugin.zip`, and `./mono.zip#tools/foo` is a folder inside `mono.zip` -
  the same shape of rule as the `@ref` split, and for the same reason. The fragment is
  dropped from the URL before the request, so the key and the GET agree.

The one cost, stated rather than discovered: a **directory** literally named `x.zip` is
read as an archive and fails at the reader rather than being installed as a folder. It is
the same class of cost as `./my-plugin/sub` having to be written with `./`, and the
failure names the fix.

## The model

Two pure additions to `types/`, both importable by everything and neither doing any I/O.

### `types/plugin-source.ts` - a fourth source

```ts
export type ArchiveAt = { kind: 'url'; url: string } | { kind: 'file'; file: FilePath };

export class ArchiveSource {
  readonly kind = 'archive' as const;
  constructor(
    readonly at: ArchiveAt,
    /** The folder inside the archive, from the `#` fragment. */
    readonly path: string | null,
  ) {}
  key(): string; // `archive:<url-or-absolute-path>[#folder]`
  reportableId(): PluginId | null; // null - named by its own author
  toString(): string;
}
```

One class for both locations rather than two, because everything except one step is
shared: the reader, the descend rule, the fragment, the record column, the trust prompt and
the telemetry answer. `at` is the one step that differs, and it is a discriminated union so
that adding a third way to get bytes is a compile error at each site that has to learn
about it - the same shape, and for the same reason, as `MarketplaceOrigin`.

The key is the spec as typed, normalised: `archive:` then the URL or the absolute path,
then the fragment if there was one. Not the `//` separator the github key uses - a URL
carries `//` in its own scheme, and `githubOf`'s `indexOf('//')` would cut it there. A
fragment cannot appear in a URL unescaped, so it round-trips exactly, and one function
splits it for both `parseSource` and `restoreSource`.

Like `local:`, the lookup folds case through `RepoSlug.same` - which is a plain
lower-cased string compare, so nothing about a URL in that column can be mangled by slug
parsing. It is still an over-match, and a sharper one than the directory key's: a URL path
is case-sensitive everywhere, and an object store's keys always are, so
`.../Plugin.zip` and `.../plugin.zip` become one row. Accepted for the reason the
directory key accepts it - one row per plugin matters more than two spellings being
distinguishable - and written down so it is a decision rather than a surprise.

`UntrustedSource` becomes `GithubSource | LocalSource | ArchiveSource`, so `confirmSource`
covers it without a new branch.

### `types/archive.ts` - what an archive is allowed to be

Pure policy, so all of it is a table test and none of it can differ between the two
readers:

```ts
export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';

export const LIMITS = { bytes: 200 * MiB, unpacked: 1024 * MiB, entries: 50_000 };

/** Never a plugin's own files, wherever they appear. */
export const IGNORED = ['__MACOSX/', '.git/', '.DS_Store'];

/** By extension, over a URL's pathname or a file name: the parse-time question. */
export function formatOf(name: string): ArchiveFormat | null;

/** By magic bytes: the read-time question, which overrules the extension. */
export function sniff(head: Uint8Array): ArchiveFormat | null;

/** `null` for anything that must not be written. */
export function safeEntryName(raw: string): string | null;

/** Which prefix inside the archive holds the plugin. */
export function pluginRoot(
  names: readonly string[],
  wanted: string | null,
  describe: string,
): Result<string, Failure>;
```

`sniff` overruling `formatOf` is the finding above made into a rule: a server that gzips a
`.tgz` for transport hands us a tar, and a reader chosen by the file name would refuse a
perfectly good archive. The extension decides whether the argument is an archive; the bytes
decide how to read it; neither matching is the failure - "that URL answered with something
that is not an archive", which is also what a 404 page served with a 200 looks like.

`safeEntryName` applies its rules **in this order**, because the order is the vulnerability:

1. Reject an empty name, a NUL byte, or a name past 4096 characters.
2. Replace `\` with `/` - **before** anything below reads a segment. A Windows-written zip
   means it as a separator, and checking for `..` first is exactly how `..\..\x` escapes.
3. Reject an absolute name: a leading `/`, a leading `X:` drive letter, a UNC `//host`.
4. Split on `/` and reject any `.`, `..` or empty segment.
5. Reject, per segment, a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`,
   `COM0`-`COM9`, `LPT0`-`LPT9`, with or without an extension), a `:` anywhere in it (an
   alternate data stream), and a trailing dot or space.
6. Reject a name that another entry has already produced. Two entries resolving to one
   path is never a plugin being built; it is the trick where the manifest this tool reads
   is not the file the editor loads - and after step 2, `a/b` and `a\b` are that case.

Then `DirectoryPath.contains` on the joined result, as a second belt - the same two-step
`downloadPath` already uses for a tree entry, because a remote name does not get to say
where we write.

## Finding the plugin inside

`pluginRoot` is the one place that answers "which prefix holds the plugin", over the entry
names alone, which is what makes it pure and exhaustively testable. It was also the part
the review broke first, so the rules are spelled out rather than implied:

1. **Ignore what is never a plugin's own file**: anything under `__MACOSX/` or `.git/`, and
   any `.DS_Store`. A zip made by the macOS Finder has _two_ top-level entries - the folder
   and its resource forks - so without this the single most likely hand-made archive in
   existence is refused for having several roots. The extractor skips the same set, which
   is `copyDir`'s `NOT_THE_PLUGIN` generalised.
2. **Read the tree from the file names, never from directory entries.** `Compress-Archive`
   writes none at all (measured). The top-level set is the first segment of every surviving
   name.
3. **A manifest at a prefix** is any of `MANIFEST_FILES` sitting directly under it -
   the same list, in the same order, that a directory and a repository are probed with, so
   the three boundaries cannot disagree about what a plugin is.
4. **Descend** while the current prefix has no manifest and exactly one directory below it,
   at most 16 times. A wrapper can wrap a wrapper; nothing legitimate nests deeper, and the
   bound is what a pathological archive does not get to turn into a loop.
5. **A `wanted` folder from the fragment is resolved under the descended root first, then
   at the literal root.** This is the correction the review forced: the entries of
   `plugin-marketplace/archive/refs/heads/main.zip` are
   `plugin-marketplace-main/plugins/slack/...`, and the user types `#plugins/slack` -
   reading the fragment from the literal root would fail on every archive that needs one.
   When both hold a manifest the descended one wins, because it is the tree the user was
   looking at when they copied the link.
6. **Every failure names the archive, not a directory on this machine**, and says which of
   the three it is: the folder you named is not in this archive (listing up to ten that
   are), the folder is there but holds no plugin manifest, or nothing in this archive does.
   An archive with no entries at all gets its own sentence - "is empty" - rather than being
   reported as holding no manifest.
7. When there is no plugin manifest but a **registry** file is present, the failure points
   at `--repo`, the way `readPluginManifest` already does for a repository that turns out
   to be a marketplace.

## Reading an archive

Four modules under `src/infrastructure/archive/`, none of which prints and none of which
throws for anything the user can fix.

**`download.ts`** - `GET` with `redirect: 'manual'`, following at most five hops by hand
and refusing any `Location` that is not https; each redirect's body is cancelled rather
than left open. `User-Agent` and `Accept: */*`, and no `Authorization` on any hop -
`ghHeaders` is deliberately not reused here, because the one thing that function does is
attach a token. The extension is checked on what the user typed and never on a hop, since a
release asset's final URL is an opaque object-store key. The body is streamed to a file in
the run's workspace, counting bytes, and `body.cancel()` ends a download that passes
`LIMITS.bytes`. A total budget of ten minutes and an idle timeout of thirty seconds between
chunks bound it in the other direction - this is the first request this program makes that
can legitimately run for minutes, so it is also the first that can hang forever without
one. A response with no `body` - only a stub has none - falls back to `arrayBuffer()`, the
same "a response this program cannot ask counts as the file" rule `carriesJson` already
uses.

**The workspace is under the state directory**, at `<state>/work/<random>/`, not
`os.tmpdir()`. On Fedora and Arch `/tmp` is a tmpfs sized at half of RAM, and a 1 GB
unpacked cap against a RAM-backed filesystem is an out-of-memory rather than a failure.
Under the state dir it is also sandboxed by `CP_STATE_DIR` for tests, like everything else
this tool writes. It is a sibling of `marketplace/`, never its parent, so the overlap guard
that protects a plugin's source keeps working unchanged.

**`zip.ts`** - positioned reads over a file descriptor, never the whole archive in memory:
the EOCD scanned from the tail, the Zip64 record when the locator is there, then the
central directory. Per entry: the general-purpose flag for encryption (refused by name, so
a password-protected archive does not read as a corrupt one), the method (`0` stored and
`8` deflate; anything else named in the failure), the declared sizes summed against
`LIMITS.unpacked` **before** anything is inflated, and `maxOutputLength` set to the
declared size so a lying header fails instead of allocating. The data offset comes from the
**local** header's own name and extra lengths, which differ from the central directory's
often enough that reading the central one is a bug that works on most archives. CRC32 is
checked on every entry.

**`tar.ts`** - gunzip to a second file in the workspace with a running cap, then walk
512-byte blocks: checksum (both the signed and unsigned sums old writers produce), ustar
magic, octal or GNU base-256 sizes, `prefix + name`, GNU `L` long names and the PAX `path=`
record. Types `0`/`\0` and `5` are a file and a directory; `1`, `3`, `4` and `6` - hard
links, devices and FIFOs - are refused by name, not skipped, because a plugin that needs a
device node is not a plugin.

**Symlinks are skipped, not fatal.** A link whose target resolves inside the extraction
root is written where the platform allows it and degraded to a copy where it does not; one
that escapes, or that cannot be resolved, is dropped with a warning naming it, and the
install continues. Refusing the whole archive for one link was the first draft, and it is
stricter than the path install this feature is meant to match: `copyDir` carries symlinks
today, so a folder that installs fine from disk would have failed from an archive of
itself.

**`index.ts`** - `openArchive(file, describe)` returns one `ArchiveReader` interface over
either implementation (`names()`, `extract(prefix, dest)`), so the fetcher, the action and
every test above this line are format-blind. `describe` is how the user named the archive,
carried in so that every failure below this line can say `my-plugin.zip` instead of a path
in the workspace.

A unix mode is applied when the archive carries one and the host is not Windows; when it
carries none the default is `0o644` / `0o755`, which is where a GitHub zipball's lost `+x`
lands.

## Where the fork lands

The four stages are `InstallStage` in `types/reports.ts`, unchanged. An archive resolves by
being read, which is to say it is the one source whose `resolve` does the fetching - and it
reports the stage accordingly:

| Stage       | An archive                                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve`   | The manifest read, once the files are out: the plugin's id and description come from its own manifest, as they do for a path.                                                                                                                                                     |
| `fetch`     | **The transfer, reported as itself.** The action sets `at = 'fetch'` around the download and extraction and back to `resolve` for the manifest read, so a failed 200 MB transfer is not counted as a failed manifest read. The `stage` is the only thing a failure event carries. |
| `harnesses` | Unchanged.                                                                                                                                                                                                                                                                        |
| `install`   | Unchanged - Cursor and VS Code copy, Claude Code is staged into the generated marketplace, because `origin.kind` is `directory` already.                                                                                                                                          |

That is the point of extracting first: after it, an archive **is** a directory install, and
`mustStage`, `stageLocalPlugin`, `conflictFor`, `recordInstall` and every harness need no
archive branch at all.

One thing it is _not_: the manifest read cannot simply be `readLocalPlugin(dir)`. Every
message that function builds is named after the directory it was given
(`${at} does not look like a plugin`, and `readManifest(data, manifestPath)`), which for an
archive is a path in the workspace that the user never typed - the same bug `CLAUDE.md`
records for reading `blob/main/tools/foo` as a folder. So `readLocalPlugin` gains a
`describeAs`, defaulting to the directory, and the archive arm passes
`.claude-plugin/plugin.json in my-plugin.zip` - the shape `readPluginManifest` already uses
for a repository. One reader, two labels.

The download is memoised on the session, keyed by the source key, so an `update` refreshing
three plugins from one URL downloads once - the same guarantee `openRepo` gives a clone.
Each archive gets its own directory inside the run's workspace, and the whole workspace is
released by the session's existing `cleanup()`, which the router calls in a `finally` on
both dispatch paths.

## Trust moves ahead of resolve

`actions/install.ts` says, today, that the confirmation "must stay ahead of any fetch or
copy", and puts it after `resolve`. For a directory that is true; for a repository it is
already slightly untrue (`session.manifest()` is a network read); for an archive it would
be plainly untrue, because resolving one means downloading up to 200 MB of a stranger's
bytes before asking whether the stranger is trusted.

So the confirmation moves above `resolve` for every untrusted source. The order becomes:

```
parse -> confirmSource -> resolve -> conflict check -> intro -> harnesses -> ...
```

What it costs: the banner that names the plugin now comes after the question, because the
plugin's name is not known until the source has been read - and the question has never been
about the name. It names the **source**, which is the thing the user is being asked to
trust and the only thing they typed. A conflict with an existing install is reported after
a "yes" rather than before, which costs a confirmed run that stops one line later. A
declined archive is also the one case where the run ends without ever learning the plugin's
id, which is harmless: an untrusted source never reports one anyway.

What it buys: the sentence in `CLAUDE.md` becomes true of all three untrusted origins
rather than one, and no bytes are fetched for a source the user then declines.

## State: one key, four origins

The record's `repo` column keeps taking whatever `key()` produces, and `restoreSource`
stays total:

| Source      | `repo` column                                 | `ref`  |
| ----------- | --------------------------------------------- | ------ |
| marketplace | `acme/plugin-marketplace`                     | a ref  |
| github      | `github:acme/mono//tools/foo`                 | a ref  |
| local       | `local:/home/me/dev/my-plugin`                | `null` |
| archive     | `archive:https://acme.com/mono.zip#tools/foo` | `null` |

`sourceKindOf` gains an `archive` answer and `restoreSource` an `archive:` arm; a key this
build cannot parse is still a marketplace repo, because a row no command can reach is worse
than a row that reads oddly. Nothing else about the record changes: the key is already
opaque to `ManifestContext`, `foldRows`, `rowShape` and `decideUninstall`, which is what
makes this a two-line change rather than a state migration.

## Per command

| Command     | What changes                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`   | The fourth arm of `resolve`, the earlier confirmation, the `fetch` stage around the transfer, and the download's two events. Everything after the extraction is untouched.                                                                                                                                                                                                               |
| `update`    | `sourceFor` restores an archive like the other two. A **file** that is gone is `unavailable` with "the archive it was installed from is gone" - an ordinary day. A **URL** that fails, fails the row, because a 404 and a bad network day are not distinguishable from here. A URL row re-downloads every time, which is what `update` means for a mutable source, the same as a branch. |
| `uninstall` | Nothing. The row is keyed and removed the way any other is.                                                                                                                                                                                                                                                                                                                              |
| `installed` | `prompts/installed.ts` prints the URL or the file for an archive row instead of `repo@ref`; `f.path` shortens a local one against `$HOME`.                                                                                                                                                                                                                                               |
| `list`      | Nothing - it lists a marketplace.                                                                                                                                                                                                                                                                                                                                                        |
| `doctor`    | Nothing.                                                                                                                                                                                                                                                                                                                                                                                 |

Three new `MarketplaceEvent`s, rendered in `prompts/marketplace.ts` (which fails to compile
without a line for each): `{ kind: 'downloading', url }` **before** the request, because
that is the line that explains the wait, `{ kind: 'unpacked', files, bytes }` after, and
`{ kind: 'entry-skipped', name, why }` for a symlink that was dropped. All of them live
inside the memoised promise, so three plugins from one archive produce one line each.

## Telemetry

`SourceKind` gains `'archive'`, which every event class already carries as a type. Nothing
else changes, and nothing new leaves the machine:

- `reportableId()` is `null` - an archive's plugin is named by its own author, the same
  judgement the path and repository arms already make.
- `MarketplaceLabel.forSource` answers `custom`, unchanged: it keys off
  `kind !== 'marketplace'`.
- The URL is never sent, and neither is its host. It is the same class of value as a
  `--repo`, which this program already refuses to send.
- A local archive and a URL archive report the same `archive`. They differ in where the
  bytes came from, which is exactly the thing that is not reportable.
- `COLLECTED` in `types/telemetry.ts` gains the fourth origin, because it is the one prose
  inventory the notice and `telemetry status` print and it has to stay in step.

## Guards

Everything a hostile archive could try, and what refuses it. Every row has a test.

| Attempt                                            | Refused by                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `../../.bashrc`, `/etc/cron.d/x`, `C:\Windows\x`   | `safeEntryName`, then `DirectoryPath.contains` on the joined path                                                     |
| `..\..\x` in a zip written on Windows              | The `\` normalisation, which runs **before** the `..` check - the ordering is the whole guard                         |
| `CON`, `NUL`, `a:b`, `trailing. `                  | The per-segment Windows rules in `safeEntryName`                                                                      |
| Two entries resolving to one path                  | The duplicate check - the manifest read would otherwise not be the file the editor loads                              |
| A symlink pointing at `/etc/passwd`                | Resolved against the extraction root; an escaping link is dropped with a warning and the rest of the archive installs |
| A hard link, device node or FIFO                   | Refused by type, named in the failure                                                                                 |
| 51 KB that expands to 50 MB (measured), or to 1 TB | The declared sizes are summed against `LIMITS.unpacked` before anything is inflated                                   |
| A central directory that lies about a size         | `maxOutputLength`, then the length check, then the CRC                                                                |
| A 5 GB response with no `content-length`           | Bytes counted as they arrive; `body.cancel()` past `LIMITS.bytes`                                                     |
| A connection that stalls mid-download              | Thirty seconds idle, ten minutes total                                                                                |
| 90,000 tiny entries                                | `LIMITS.entries`                                                                                                      |
| An encrypted archive                               | The general-purpose flag, named as encrypted rather than reported as corrupt                                          |
| A redirect from https to http                      | Hops followed by hand, each checked; no credential is sent on any of them anyway                                      |
| An HTML error page served as 200                   | `sniff` - neither magic matches, so the failure says what arrived                                                     |
| An archive that is a marketplace, not a plugin     | `pluginRoot` finds a registry and no manifest, and points at `--repo`                                                 |

## File map

| File                                     | Change                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/types/archive.ts`                   | **new** - formats, limits, `IGNORED`, `sniff`, `safeEntryName`, `pluginRoot`                 |
| `src/types/plugin-source.ts`             | `ArchiveSource`, the parse step, the key, `restoreSource`, `sourceKindOf`                    |
| `src/types/ports.ts`                     | `FetchResponseLike` gains optional `body` and `url`; `SourceFetcher` gains `fetchArchive`    |
| `src/types/session.ts`                   | `Session.archive()`, three `MarketplaceEvent` kinds                                          |
| `src/types/telemetry.ts`                 | `COLLECTED` gains the fourth origin                                                          |
| `src/infrastructure/paths.ts`            | `workspaceDir()`, a sibling of `marketplace/` under the state dir                            |
| `src/infrastructure/archive/download.ts` | **new** - hop-by-hop https GET, capped and bounded, into the workspace                       |
| `src/infrastructure/archive/zip.ts`      | **new** - central directory, Zip64, stored + deflate, CRC                                    |
| `src/infrastructure/archive/tar.ts`      | **new** - gunzip, ustar, GNU long names, PAX                                                 |
| `src/infrastructure/archive/index.ts`    | **new** - `openArchive`, the one `ArchiveReader` interface                                   |
| `src/infrastructure/local-plugin.ts`     | `readLocalPlugin` gains `describeAs`, defaulting to the directory                            |
| `src/infrastructure/source-fetcher.ts`   | `fetchArchive`: workspace, download-or-open, `pluginRoot`, extract, return a `DirectoryPath` |
| `src/infrastructure/session.ts`          | The archive memo, and its cleanup                                                            |
| `src/actions/install.ts`                 | The archive arm of `resolve`; the confirmation moves above it; the `fetch` stage             |
| `src/actions/update.ts`                  | `sourceFor` - a missing archive file is `unavailable`                                        |
| `src/prompts/install.ts`                 | `where()` for an archive                                                                     |
| `src/prompts/installed.ts`               | `origin()` for an archive row                                                                |
| `src/prompts/marketplace.ts`             | The three new events                                                                         |
| `src/commands/help.ts`                   | The source table and an example                                                              |
| `CLAUDE.md`, `README.md`                 | The model, the guards, the `.tar.gz`-keeps-`+x` note                                         |
| `.github/workflows/ci.yml`               | Three smoke steps                                                                            |

## Test map

The suite drives the real readers over archives **built in the test**, so nothing binary is
committed and the hostile cases can be written down rather than found.

| Test                                          | Covers                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/archive-fixture.ts` **new**             | A zip writer (stored and deflate, Zip64, encrypted flag, bad CRC, a traversal name, a backslash name, a duplicate name, a symlink entry, **no directory entries**, a `__MACOSX/` sibling) and a tar writer (ustar, PAX, long name, a device entry). Both in memory.                                                                                                                                                     |
| `test/types/archive.test.ts` **new**          | `formatOf` over paths with queries and fragments; `sniff` over every magic; `safeEntryName` over the traversal, device-name and duplicate tables, including the `\`-before-`..` ordering; `pluginRoot` over root / one wrapper / two wrappers / a `__MACOSX` sibling / no directory entries / several roots / a named folder under a wrapper / a named folder at the root / both / neither / a registry instead / empty |
| `test/types/plugin-source.test.ts`            | The parse table above, the `#` split, the `@` that is not a ref, a query string, http refused, `key()` round-tripping through `restoreSource`                                                                                                                                                                                                                                                                           |
| `test/infrastructure/archive.test.ts` **new** | Both readers over the fixture, every guard row, the caps, and that every failure message names the archive rather than the workspace                                                                                                                                                                                                                                                                                    |
| `test/infrastructure/source-fetcher.test.ts`  | `fetchArchive` over a stub fetch: the hop chain, a downgrade to http, the byte cap, the idle timeout, a non-archive body                                                                                                                                                                                                                                                                                                |
| `test/install-archive.test.ts` **new**        | End to end through `Wiring`: a URL and a file, a `#folder` under a wrapper, the trust prompt coming before the download, the record, `update` re-downloading once for two plugins from one URL, `uninstall`                                                                                                                                                                                                             |
| CI `smoke`                                    | Zip a folder in the job and install `./smoke.zip`; then install `https://github.com/context-plugins/plugin-marketplace/archive/refs/heads/main.tar.gz#plugins/slack` into a sandboxed Cursor and VS Code, and uninstall                                                                                                                                                                                                 |
| CI `claude`                                   | The same URL into a real `claude`, asserting on `claude plugin list --json`                                                                                                                                                                                                                                                                                                                                             |

The smoke URL is the one the existing "folder inside a real repository" step already
depends on, so it adds no new external dependency - and it is the case that matters,
because it exercises the wrapper descend and the fragment together. **This repository is
not itself a plugin** (there is no `.claude-plugin/plugin.json` at its root), so its own
archive URL cannot be the fixture.

The two CI steps matter for the reason the existing ones do: everything else drives a fake
fetch, which cannot serve a chunked body, cannot redirect, and cannot answer with the
archive GitHub actually builds.

## Phases

One branch, `saeedjamshaid/install-from-archive`, one pull request. Each phase leaves the
suite green.

| #   | Type        | Scope                                                                                                                                               |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `refactor:` | The confirmation moves above `resolve`; `FetchResponseLike` grows `body`/`url`; `readLocalPlugin` grows `describeAs`. No new behaviour, no release. |
| 2   | `feat:`     | `types/archive.ts` and `infrastructure/archive/*` with their tests. Complete, tested, and reachable from nothing yet.                               |
| 3   | `feat:`     | `ArchiveSource`: parse, key, restore, the workspace, the session memo, the download, the `resolve` arm. `install` works from a URL and from a file. |
| 4   | `feat:`     | `update`, `installed` and the prompts; the guards' failure messages; the `fetch` stage; telemetry's fourth origin.                                  |
| 5   | `docs:`     | `CLAUDE.md`, `README.md`, `help.ts`, and the three CI smoke steps.                                                                                  |

Phase 2 is the one to review slowly: it is the only code here that reads bytes a stranger
wrote, and it is where every guard lives.

## Open items

1. **`.tar` uncompressed** is included above (the reader is the tar reader with the gunzip
   step skipped, so it is nearly free). Say so if it should not be.
2. **The lost `+x` on a GitHub zipball** is documented rather than worked around. The
   alternative - inferring the bit from a `hooks/` path or a `#!` shebang - guesses at
   something the archive genuinely does not say. It earns a line in `README.md`, in the
   form "prefer the `.tar.gz` link".
3. **Windows `MAX_PATH`.** A deep archive under `<state>/work/<random>/files/` has a longer
   prefix than a clone's, and Node without long-path support fails at 260 characters. No
   fix proposed - the shape is the same one the clone path already has - but the failure
   should name the length rather than read as a missing file.
4. **A cached download** across runs is deliberately absent: without a digest to key it on,
   a cache of a mutable URL is a stale install waiting to happen. It becomes easy the day
   integrity arrives.
5. **`--repo` pointing at an archive** - a marketplace delivered as a zip - stays out of
   scope; `pluginRoot` only points at `--repo`, it does not follow it.

## Out of scope

Digest pinning and `#sha256=`; any credential, header or netrc for a private URL; a
cross-run cache; `.7z`, `.rar`, `bzip2` or `xz`; an archive as a marketplace; and
`--link`-style installs from an archive, which is a contradiction.

## What the review changed

An adversarial pass over the first draft, run against the real code and real archives.
Four findings were breaking, and the first two were the same mistake seen twice.

| #   | Finding                                                                                                                                                  | Change                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | The fragment was resolved at the literal root, so `#plugins/slack` missed `plugin-marketplace-main/plugins/slack` - every archive that needs a fragment. | `pluginRoot` resolves `wanted` under the descended root first, then at the literal root. |
| 2   | The proposed CI smoke installed this repository's own archive. It is not a plugin.                                                                       | The marketplace repo's archive plus `#plugins/slack`, which exercises finding 1 in CI.   |
| 3   | The archive arm reused `readLocalPlugin`, whose messages name the directory - here, a workspace path the user never typed.                               | `readLocalPlugin` gains `describeAs`; the archive arm names the archive.                 |
| 4   | "Exactly one top-level directory" is false for any zip made by the macOS Finder, and directory entries are optional anyway.                              | `IGNORED`, and the top level read from file names.                                       |
| 5   | "The URL path ends in `.zip`" was under-specified, and presigned URLs are the only route to a private archive here.                                      | `new URL(spec).pathname`, with a row in the spellings table.                             |
| 6   | A failed 200 MB transfer would have reported `stage: resolve`, the same as a failed manifest read.                                                       | The action sets `fetch` around the transfer.                                             |
| 7   | Refusing an archive outright for one symlink is stricter than `copyDir`, which carries them today.                                                       | Skip and warn; refuse only escapes.                                                      |
| 8   | `os.tmpdir()` is a RAM-backed tmpfs on Fedora and Arch, against a 1 GB unpacked cap.                                                                     | The workspace moves under the state directory.                                           |
| 9   | No timeout on the one request this program makes that can legitimately take minutes.                                                                     | Thirty seconds idle, ten minutes total.                                                  |
| 10  | `\` normalisation and the `..` check were both stated, without their order - which is the entire vulnerability.                                          | `safeEntryName`'s rules are numbered.                                                    |
| 11  | "A device name" was a gesture, not a rule; duplicates were unaddressed.                                                                                  | The Windows list and the duplicate check are written out.                                |
| 12  | The guard table claimed the overlap check protected an archive. Extraction goes to a workspace, so it can never fire.                                    | Row dropped.                                                                             |
| 13  | The header claimed the plan was verified on Node 18. Nothing was.                                                                                        | The header says what was measured, where, and what is taken from the changelog.          |
| 14  | Smaller: a `--ref` alongside an archive was silently dropped; an empty archive read as "no manifest"; case folding hurts a URL key more than a path key. | Each is now stated where it belongs.                                                     |

Four things the review tried to break and could not, recorded so they are not re-litigated:
`RepoSlug.same` is a plain lower-cased string compare and cannot mangle a URL in the `repo`
column; `body?: AsyncIterable<Uint8Array>` compiles against the pinned `@types/node@18`
under this repo's own tsconfig, with a real `fetch` response assigned to it; `mustStage`,
`stageLocalPlugin`, `conflictFor` and `recordInstall` genuinely need no archive branch; and
`PluginId`'s pattern cannot match `p.zip`, so the new extension rule cannot shadow an
argument that already works.
