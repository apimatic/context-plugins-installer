# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`context-plugins` installs plugins into Claude Code, Cursor, and VS Code with one
command - from a plugin marketplace (a GitHub repo carrying a
`.claude-plugin/marketplace.json` registry), from a directory on the machine
that is itself a plugin, from a GitHub repository (or a folder inside one)
that is itself a plugin, or from a `.zip` or `.tar.gz` of one, at an http(s) URL
or on this machine. Published to npm; users run it via `npx`. The README is end-user documentation
only, by explicit decision — contributor and agent knowledge belongs here, not there.

## Commands

- `npm test` — full suite; `npx tsx --test test/types/manifest-context.test.ts` runs one file
- `npm run typecheck` — strict `tsc` over `src/` and `test/`, no output
- `npm run build` — emits `lib/` (gitignored; `prepare` builds it for publish, for a
  git-URL install, and after a plain `npm ci`)
- `npm run lint` / `npm run lint:fix` — eslint 9 flat config, typescript-eslint, sonarjs bug rules
- `npm run format:check` / `npm run format` — prettier
- `npm run syntax` — bare `node --check` of the plain-JS entry points

Tests run the TypeScript in `src/` directly through tsx — there is no build in the loop, on
purpose. `bin/cli.js` requires the compiled `lib/`, so exercising the real entry point
(`node bin/cli.js ...`) needs `npm run build` first; CI's two smoke jobs do exactly that.
`smoke` covers the marketplace, a folder and a repository against Cursor and VS Code;
`claude` installs the real `claude` binary and asserts on **its** answer — what it lists,
not what we recorded. That second job exists because everything else drives a fake
`ProcessRunner`, which asserts the argv and cannot refuse a file: the generated
marketplace shipped without the `owner` Claude's schema requires, so that whole arm never
worked, and every test stayed green. The CLI is installed unpinned there on purpose —
pinning it would stop it noticing the next change to a schema this project does not own.

## Hard constraints

- **Zero runtime dependencies, ever.** This is the package's identity: `npx` starts
  instantly, the shipped source is auditable, and the supply-chain surface is nil.
  Hand-roll instead of installing (see `which()`, `pool()`, the boundary validators).
  devDependencies are fine; nothing goes under `dependencies`.
- **Commit types are release decisions.** semantic-release publishes to npm from commit
  messages: `fix:` / `feat:` / `perf:` trigger a release; `refactor:` / `chore:` /
  `docs:` / `style:` do not. commitlint enforces conventional commits on every PR.
- **Never `shell: true`.** Spawning goes through `run()` in
  `src/infrastructure/process-runner.ts`, which routes Windows
  `.cmd` shims through cmd.exe with explicit quoting (Node refuses to spawn `.cmd`
  directly since the CVE-2024-27980 hardening).
- **All terminal output goes through `src/prompts/terminal.ts`** — no `console.log` elsewhere.
  Glyphs are built from char codes with ASCII fallbacks for legacy Windows consoles;
  keep the source itself ASCII, escaping any character that must not be normalised
  (`\u00a0` in `toAscii` — the port lost that one to an editor once already).
  `debug` and `warnStderr` write to stderr so `--json` output stays parseable; anything
  a `--json` path emits alongside the payload has to use them. It is the one file the
  `no-console` rule exempts, and only `src/prompts/` may import it: every layer that
  may reach a prompts class is separately barred from reaching past it to the writer,
  so "all output goes through a prompts class" is a lint failure rather than a habit.
- **Validate at the edges, never cast.** Anything crossing a JSON boundary (manifest,
  registry, rc file, `claude` CLI output, GitHub API responses) or entering argv/URLs
  (plugin, repo, ref) is validated where it enters, with `isPlainObject` /
  `nonEmptyString` from `types/util.ts`. `as` on parsed JSON is the anti-pattern. The
  manifest drops bad entries from its read view but never from disk (it is shared
  state; a newer CLI may own a row); the rc file fails loudly naming the file (it is
  user-written configuration). Keep that split. Nothing in `src/` turns a `Failure`
  back into a throw: that conversion exists only as `throwFailure` in
  `test/helpers.ts`, for the several hundred assertions written against the throwing
  shape, and a copy of it appearing under `src/` is the bridge Phase 6 removed
  growing back.
- **Node 18 is the engine floor**, and `@types/node` is pinned to 18 so the compiler
  cannot let a newer API in. tsx is the price of running TypeScript tests on 18/20.
- **TypeScript stays on 6.x** until typescript-eslint's peer range admits 7 (`<6.1`
  today). TypeScript 7 is also what breaks eslint-plugin-sonarjs v2+, which is why
  sonarjs is pinned to v1.
- **Telemetry is anonymous, flat, and optional.** Events leave only through
  `src/infrastructure/telemetry-service.ts` and the `mixpanel-client.ts` it calls, in
  one POST to Mixpanel's `/track` at the end of `cli.run`
  (`ip=1`: Mixpanel adds city, region and country from the request address at ingestion
  and discards the address; the CLI never sends location itself), bounded by a timeout
  and never allowed to fail or hold a run. The project token in `types/brand.ts` is a public
  routing key, not a secret; the project is US-resident, so the host stays
  `api.mixpanel.com`. Properties are
  primitives only, and `COLLECTED` in `types/telemetry.ts` is the one prose inventory the
  notice and `telemetry status` print; keep it, `common`, and the properties each event
  class in `types/events/` declares (`plugin` once validated - and withheld entirely for a
  plugin installed from a directory, whose name came from a folder the user chose - `harness`,
  `marketplace` as the built-in repo or `custom`, `source_kind` as `marketplace`,
  `github`, `local` or `archive`, `stage`, `error_kind`, `targets_explicit`,
  `duration_ms`) in step. An archive reports the kind and nothing else: not the
  URL, not its host, and not the plugin's name - a local archive and one at a URL
  are the same `archive`, because where the bytes came from is exactly the part
  that is not reportable.
  `PluginSource.reportableId` is where that id is decided and
  `MarketplaceLabel.forSource` where a path or repo install is kept from naming the
  built-in marketplace it never touched: both live on the types, so no command answers
  either question for itself. Only the marketplace arm answers with an id at all: a
  plugin installed from a path or a repository is named by its own author, and a
  repository the user named is the same class of thing as the `--repo` this program
  already refuses to send - it can be private, and nothing downstream could act on a
  third party's plugin id anyway. `reportableId` therefore takes no argument: it was
  given the id the run had learned while the `github` arm reported one, and with no arm
  using it the parameter went the way `needsSource(origin)` did in phase 1. Never send
  a path, hostname, username, error message, env var, or a user-supplied `--repo`
  - which is why `MarketplaceLabel.of` answers with the built-in constant or
    `custom` and never with `brand.repo` (not to be confused with the rc file's
    `marketplaceLabel`, which is the display name and never leaves the machine): a differently cased spelling of the
    built-in marketplace counts as the built-in one, and the spelling stays home.
    Opt-out precedence is `DO_NOT_TRACK`, `CP_TELEMETRY=off`, rc `"telemetry": false` in
    _either_ rc file, then the state file, which fails closed: a `telemetry.json` that
    exists but cannot be read or parsed disables telemetry rather than being replaced, and
    `enabled: false` is honoured even without an id. If the state directory cannot be
    written, nothing is sent (no stable id, and the notice would repeat).
    `CP_TELEMETRY=log` prints the payload instead of sending it. The one-time notice and
    the log mode go to stderr through `log.notice`, which ignores `--quiet` on purpose.
    `createTelemetry` does no I/O and never dereferences global `fetch`; everything is
    resolved in `flush`, only once something was tracked. Tests never reach the network:
    `scripts/test.js` sets `CP_TELEMETRY=off`, the CI smoke job does too, and a test
    passes its own `EventSink` to the command instead of the one the composition root
    builds - which is wrapped, so a throwing sink cannot fail a run.

## Architecture

Every command flows `bin/cli.js` → `src/main.ts` (builds the services, once) →
`src/commands/router.ts` (parse, brand, dispatch, exit code) →
`src/commands/<cmd>.ts` (flags in, events out) → `src/actions/<cmd>.ts` (the
whole flow of one command) → the harness that owns each editor, with every
user-visible string in `src/prompts/<cmd>.ts`.

Read a directory as **what it is allowed to reach**, not by what happens to sit
in it. Every file in `src/` is in one of these, and `eslint` enforces the
boundaries from `no-restricted-imports`, so a crossing import fails
`npm run lint` rather than review. "The writer" below is
`prompts/terminal.ts`: the layers that may reach a prompts class still may not
reach past it to the terminal itself.

| Directory         | May import                                      | And is                                                |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `types/`          | `types/`                                        | the model, and no I/O at all                          |
| `application/`    | `types/`                                        | pure decisions: data in, data out                     |
| `infrastructure/` | `types/`, node builtins                         | the world, answering with a `Result`, never printing  |
| `prompts/`        | `types/`, `prompts/`                            | every user-visible string, and the only `console`     |
| `harnesses/`      | `types/`, `infrastructure/`                     | one editor each, emitting events rather than speaking |
| `actions/`        | all but `commands/` and the writer              | one command's whole flow                              |
| `commands/`       | `types/`, `actions/`, `prompts/` bar the writer | flags in, telemetry events out                        |
| `composition/`    | all but `actions/`, `commands/`, the writer     | the only place that names a concrete service          |
| `main.ts`         | `commands/`, `composition/`                     | argv in, exit code out                                |

Two rules in that table are worth saying out loud, because both were argued
with and both won. **`commands/` may not import `infrastructure/`** - that is
what forces the composition root to exist, and a service reaches a command as a
port from `types/` rather than by being fetched. And **nothing may import
`composition/` or `main.ts`**, which is the hole the rules had while five
modules sat loose at `src/` root. It is worth reading the message when one of
these fires, because more than one of this refactor's decisions was made by that
rule rather than by preference: the `Services` port sits in `types/` because a
command naming the module that builds its services is exactly the crossing the
rule refuses.

Three things about that enforcement are worth knowing before trusting it,
because each was a hole found by probing rather than by reading:

- **Every glob has two spellings.** A directory holding an `index.ts` is
  reachable without naming it - `'../harnesses'` resolves the same as
  `'../harnesses/index.js'` under this tsconfig - and a pattern ending in `/**`
  does not match the bare form. Both are listed for every layer, by `dir()`.
  The same is true of a pattern that names a **file**, which is subtler and was
  a real hole: the rule matches the specifier as written, so dropping `.js` from
  `'../prompts/terminal.js'` type-checked, emitted a working `require`, and
  walked an action straight past the writer boundary. `file()` spells those
  both ways too, and no pattern in the config names one spelling only.
- **Dynamic `import()` is barred outright in `src/`**, by
  `no-restricted-syntax` rather than by the boundary rules, because
  `no-restricted-imports` reads static imports and re-exports only: an
  `await import(...)` crossed every boundary here without a word. Nothing loads
  lazily today, so nothing may; a lazy load has to add its own case first.
- **The root is one file, and a test says so.** `src/*.ts` carries the entry
  point's boundary, so a module added beside `main.ts` inherits the
  restriction rather than arriving with none - but no glob can express "there
  should not be a second one", so `test/layering.test.ts` asserts that the root
  holds `main.ts` alone and that every directory under `src/` is a layer the
  lint has a rule for.

An action answers with an `ActionResult<R>`: success, failure or cancellation,
each carrying the run's report, because a command fires telemetry from those
facts whether the run worked or not. A `failure` is optional on the failed arm -
`doctor` prints its own checks and its own summary, and `update` its grid, so
there is no sentence left for the router to add - and the exit code comes off
the arm: 0, 1, or 130 for a cancel. Exit 2 is the router's own, for a command
line it could not read, which includes an rc file it could not parse.

**Nothing throws for a problem the user can fix.** There is no `UserError`: a
problem the user can fix is a `Failure` on the failed arm, which the router
prints as its message and its hint and telemetry counts as `user`. A throw that
reaches the router is a bug - it prints the stack under `--verbose`, exits 1,
and is counted as `unexpected`. That distinction is the whole reason both
values exist, so a new "expected" failure must never be a throw: return it.
The same rule made Ctrl-C an answer rather than an exit, since
`process.exit(130)` inside the prompter took the run's own cleanup with it.

### `src/types/` - the model everything else is written in

The bottom of the stack: importable by everything, importing nothing, and doing
no I/O - `no-restricted-imports` bars the node builtins that touch the world or
the clock, `node:crypto` included, because a decision that mints a UUID is not a
decision that can be tested twice, and `node:module` because `createRequire`
reaches every other entry on that list. It is a denylist rather than "every
builtin": `node:path` is on neither side of it, because `types/file/paths.ts`
needs `path.win32` and `path.posix` to carry a target platform's rules. It is not a folder of `interface`s. Rules live on the type that
owns them, and most of this file's invariants are enforced from here. It is the
model for the whole surface, so keep it in sync when behavior changes: a rule
that ends up somewhere else is a rule two callers can disagree about.

- **`types/ids/`** - `PluginId`, `RepoSlug`, `GitRef`, `MarketplaceName`. A
  boundary that receives a string calls `create()` and turns `undefined` into
  the failure message; nothing downstream re-validates. `RepoSlug.same` is the
  case-insensitive comparison the whole program owes GitHub, and it is a static
  taking untrusted values because most callers hold a string, not a slug.
- **`types/file/paths.ts`** - `DirectoryPath` and `FilePath`, each carrying its
  own `PathRules` (`path.win32` or `path.posix`). This is why a Windows path is
  exactly assertable from Linux CI, and why a harness needs no path arithmetic:
  it asks `srcDir.file(...)`.
- **`types/result.ts`** and **`types/failure.ts`** - `Result<T, Failure>` is how
  infrastructure answers. A `Failure` is a message and a hint, which is exactly
  what the router prints.
- **`types/http.ts`** - `hostOf` and `isUpstreamOutage`: the two questions every
  boundary that speaks HTTP asks about a response, and the only two. Down here
  rather than in `github-registry-client.ts`, where they started, because three
  modules ask them - the registry read, the repository fetch and the archive
  download - and only one of those is about GitHub. `upstreamFailure` stays with
  the registry client, since its hint names GitHub on purpose.
- **`types/events/`** - one class per telemetry event, each declaring its own
  property names in a `properties()` method. That is the whole Mixpanel
  contract: nothing else can misspell or widen it. `EventSink` is where they go.
- **`types/ports.ts`** and **`types/services.ts`** - the interfaces this program
  reaches the outside through (`RunCommand`, `FetchLike`, `ManifestStore`,
  `Telemetry`, `TelemetrySettings`, `Prompter`, `RegistryClient`,
  `SourceFetcher`, `ProcessRunner` and the `HttpPorts` / `SourcePorts` bundles),
  plus
  `Services`, the bundle a run needs built. They are ports rather than
  implementations so that a command can name what it needs without naming what
  builds it.
- **`types/harness.ts`** - the names and titles of the editors as static
  knowledge, so a pure decision can say "Cursor" without importing the code
  that installs into it, and the `Harness` contract itself. `HarnessContext`
  carries the marketplace as an `origin`, named for what it holds so that no
  reader has to rename it to read it.
- **`types/plugin-source.ts`** - what the user asked to install, parsed once at
  the front of the run: a marketplace id, a directory, or a GitHub repository
  that is itself a plugin. The order the three are told apart in is the whole
  contract. `PluginId` is tried first, which is the guarantee that no argument
  this program already accepted changes meaning; anything starting with `.`, a
  separator, `~` or a drive letter is a path, because that is the one shape no
  slug can have; anything left holding a `/` - or spelled as a github.com URL
  or an scp address - is a repository; and anything with none of those keeps
  the id's own failure, so a typo still reads as a typo. The cost of that
  order, stated rather than discovered: a relative folder has to be written
  `./my-plugin/sub`, because `my-plugin/sub` is a repository. An `@ref` is
  split at the **last** `@` rather than matched, since `release/1.0` is a
  branch name a user will type, and it is split off what is left once the host
  has been consumed rather than off the whole argument: guarding that split on
  the spelling instead - to keep the `@` in `git@github.com` out of it - is what
  kept a ref off a URL entirely. A ref written by hand wins over one the URL
  already carried, being the more deliberate of the two. The segment after
  `owner/repo` in a github.com URL is a **view word**, and `tree` is the only one
  that names a folder: the file views and the repository's pages are refused by
  name, because reading `blob/main/tools/foo` as a folder reported a plugin
  missing from a path the user never typed. Only a URL carries views - the
  `owner/repo/folder` shorthand still names a folder called `blob` if that is
  what it is called. `key()` is the manifest's `repo` column - a
  marketplace source's is the repo verbatim, so no record migrates, and the
  other three are prefixed `local:` / `github:` / `archive:` so they can never
  collide with a
  slug; a repository's folder is separated by `//`, which is what keeps two
  plugins out of one monorepo in two rows. An archive's is separated by the `#`
  the user typed instead, because a URL carries `//` in its own scheme and
  `githubOf`'s `indexOf('//')` would cut it there. `restoreSource` reads that column
  back into a source and is **total**: a key this build cannot parse is a
  marketplace repo, because a row that no command could reach is worse than a
  row that reads oddly. `sourceKindOf` is the same question for a caller that
  only needs to branch. A repository's folder is validated here the way an id
  and a ref are, and for the same reason: it reaches `git sparse-checkout add`
  as argv, where a leading `-` is an option, and a raw.githubusercontent.com
  URL as a path, where a `?` or a `#` truncates the request and some other file
  would be read as the manifest. It is pure: whether a directory or a repository really
  holds a plugin is a question for `infrastructure/local-plugin.ts` and
  `readPluginManifest`, which go and look. The fourth arm is an **archive**,
  and it is told apart before the repository one so that a github.com URL
  naming a release asset or an `archive/` link is read as what it is rather
  than refused as a view word. The test is the URL's **`pathname`** ending in
  an extension `formatOf` knows, never the whole string: a presigned link is
  the only way a private archive is installable here - no credential is ever
  sent - and its query would otherwise hide the extension. An `http` URL is
  accepted, and `ArchiveSource.plainHttp` is what the trust confirmation asks,
  so a plugin that runs commands and arrives with no signature and no TLS is
  warned about before anything is fetched, `-y` or not. What stays refused is
  a server choosing http for the user: see the redirect rule in `download.ts`.
  Only the four spellings `formatOf` knows name an archive, and nothing else
  is answered for: a `.7z` or a `.tar.bz2` link falls through to the repository arm like any other URL this
  program cannot read. A denylist of the formats it cannot read was tried and
  removed - it bought one better sentence at the price of a list that reads as
  exhaustive, can never be, and has to be maintained; and a blanket "unknown
  extension" rule is not available in its place, because that also describes
  `github.com/acme/repo/tree/main/tools/foo.js`, which has to keep parsing as a
  folder. `./my-plugin.rar` is likewise a directory someone named oddly as
  readily as it is an archive, so the spec stays with the arm that can go and
  look. Only a URL or a path can be an
  archive, so `acme/my-plugin.zip` is still a repository; an `@` is part of
  the name, since an archive has no ref; and the `#folder` is split at the
  **last** `#`, and only when what precedes it is itself an archive, so
  `./my#plugin.zip` is a file with a `#` in its name. An **empty** fragment
  names no folder and is dropped rather than left on the spec: carried along
  it put a meaningless `#` in the key a URL is recorded under, and turned
  `./p.zip#` into a directory of that name, because `formatOf` saw the `#`
  too. `ArchiveSource` covers
  both a URL and a file in one class because only one step differs, and that
  step is a discriminated union for the same reason `MarketplaceOrigin` is.
  `location()` is the archive without the folder inside it: what a reader is
  named after, and what the session memoises on, so two plugins out of one
  monorepo archive cost one download and two extractions.
- **`types/archive.ts`** - what an archive is allowed to be, as rules rather
  than as code that reads one, so the zip reader and the tar reader cannot
  disagree about any of it. Three of those rules answer something measured:
  the **bytes** pick the reader rather than the extension, because `fetch`
  decodes a `Content-Encoding: gzip` and a `.tgz` served that way arrives as a
  bare tar; the tree is read from the **file names**, because
  `Compress-Archive` writes no directory entries at all; and `__MACOSX/` is
  ignored, because every zip the macOS Finder makes carries one and "exactly
  one top-level directory" is false for all of them. `EntryNames` holds the
  rules an entry name passes **in order** - the order is the guard, since
  normalising `\` after checking for `..` is how `..\..\x` escapes on Windows -
  and answers `write`, `ignore` or `refuse`, the last of which ends the whole
  archive rather than part of it. A `.` segment is dropped, not refused:
  `tar -czf x.tgz .` writes every name as `./...`. Duplicates are found
  case-folded, because on Windows and macOS `README` and `readme` are one
  file and the later entry would silently be the one read - but only a
  **file** claims a name, since a directory entry writes nothing and refusing
  `Docs/` beside `docs/` ended an archive Linux is entitled to hold over a
  collision with no consequence. Each reader says which it has (the trailing
  separator, the type byte); the parameter defaults to a file, so a caller
  that says nothing gets the rule rather than the exemption. `pluginRoot` unwraps a lone directory while
  the level holds nothing else, keeps the whole chain rather than its end, and
  resolves a `#folder` under the deepest of them first: the entries of a GitHub
  archive are `<repo>-<ref>/plugins/slack/...` and the user types
  `#plugins/slack`, so reading the fragment at the literal root would fail on
  every archive that needs one.
- **`types/plugin-manifest.ts`** - a plugin's own `plugin.json` as this build
  reads it, beside `normalize` in `types/catalog.ts` for the same reason: two
  boundaries read those bytes (a directory, and a repo over both GitHub hosts)
  and neither should decide what a usable manifest is. `MANIFEST_FILES` is the
  probe order, Claude Code's location first. The `name` is the id everything
  downstream uses - never the folder's name, which can be renamed without the
  plugin changing what it is.
- **`types/marketplace-origin.ts`** - where the marketplace a run installs from
  lives, in the vocabulary `claude plugin marketplace list --json` answers in.
  One value rather than the marketplace name and its repo as two fields, which
  travelled side by side from the resolver through two contexts to the harness
  with nothing stopping a caller from pairing a name with the wrong repository.
  `name` is nullable because an offline uninstall genuinely has none - the
  harness asks the CLI - and `key()` is the session's memo key, case-folded on
  the repo so two spellings register once. It is a discriminated union with one
  arm today; the discriminant is there from the start so a second kind is one
  line here and a compile error at each site that has to learn about it.
  `NamedMarketplace` is the same value with the name known, and the reason
  registering a marketplace takes one value rather than an origin and a name
  side by side - which would have been the very pairing this type removed.
  `RepoMarketplace.named` and `hasName` are the only ways to hold one, so
  `ResolvedPlugin` states "the name is always known here" as a type rather than
  as a promise in a comment, and a nameless origin cannot reach the code that
  needs a name. `named` takes the validated `MarketplaceName` rather than a
  string, so the claim its return type makes is carried by the argument instead
  of by a cast over user input, and `hasName` asks `nonEmptyString` - the same
  question the harness asks of Claude's own listing, so an empty name cannot
  clear one guard and be spelled into `plugin install <id>@`. `key()` leads
  with the discriminant and folds only the repo: it is an in-memory per-run
  key, so the format is free, but two origins of different kinds agreeing on
  one would hand a caller the other's cached registration. The `directory` arm
  is the marketplace this tool generates for plugins that came from a path; its
  name is never unknown, because we chose it, so every instance of it is
  already a `NamedMarketplace`.
- **`types/installed-record.ts`** and **`types/manifest-context.ts`** - every
  rule about a manifest row, and the file as a domain object. See **State**.
- **`types/util.ts`** - the pure helpers, and the reason they sit here: `types/`
  imports them, so the bottom of the stack is the only place they can be
  without a hole in the rule above.

### `src/application/` - the decisions, with nothing to mock

Four modules, all pure: `brand-resolution.ts` (flag, env and both rc files into
one `Brand`), `plugin-resolution.ts` (a typed plugin id out of a catalog, with
the did-you-mean suggestion), `target-selection.ts` and `uninstall-decision.ts`.
Data in, data out, no clock and no randomness - which is what lets
`test/application/uninstall-decision.test.ts` walk the entire space
`decideUninstall` is defined over rather than a handful of cases. When a
decision needs a fact from the world, the fact is a parameter.

### `src/infrastructure/` - the world, and it never prints

Nineteen modules over the file system, the network, the process table, the
`claude` binary and the state files. Two rules hold across all of them, and both
are lint-enforced: they answer with a `Result` rather than throwing, and they
say nothing. Whether anyone hears a diagnostic depends on `--verbose`, which is
not a service's business to know - so what a service used to print is either a
`TelemetryLine` on the way back or an event on a listener, and a prompts class
renders it. `paths.ts` is here because it is infrastructure, and while it sat at
`src/` root the boundary rule could not say what this directory may import.

- **Session** (`src/infrastructure/session.ts`): work shared by every plugin in one run — the
  registry fetch, the plugin-manifest read, the repo clone, the Claude marketplace
  registration — each done
  once, keyed `repo@ref` with the repo lower-cased - two spellings are one
  repository, and keying on the spelling made one `update` read the registry
  twice and clone it twice, announcing both; `ensureMarketplaceOnce`'s key folds
  the same way. Promises are cached rather than results, so concurrent
  callers share one request and a deterministic failure is not retried. `update`
  threads one session through all plugins; a lone `install` gets a throwaway one.
  It reads the registry through `infrastructure/github-registry-client.ts` and the
  plugin source through `infrastructure/source-fetcher.ts`, and like everything in
  that directory neither prints nor throws: both answer with a `Result`, and
  everything they used to say out loud is a `MarketplaceEvent` that
  `prompts/marketplace.ts` renders. Emitting rather than returning is what keeps
  each line where it was: the fallback to the GitHub API and the start of a clone
  explain a wait, so they have to arrive before it, and a registry file skipped
  for being unreadable has to survive a later file failing. It is also what makes
  the session's memo govern how often a line is said - the words happen inside the
  cached promise, with the work, so three plugins from one repo produce one line
  and not three. Reporting from the returned value instead put it at the caller
  and said it once per plugin; that is a real regression this rule prevents.

- **Two hosts, one file** (`fetchRepoFile` in `infrastructure/github-registry-client.ts`):
  every file read by URL - the registry, a plugin's own manifest, and
  every blob of a plugin on the no-git path - is asked of
  `raw.githubusercontent.com` first and of the API's
  contents endpoint second (`RepoSlug.contentsUrl`, with
  `Accept: application/vnd.github.raw`, so the body is the file itself and not a
  base64 envelope of it). They are separate services, and the raw CDN's own 503
  was the most common way an install failed for no reason. Only
  `isUpstreamOutage` falls back: a 404 is the answer to the question the registry
  read asks twice, a 403 is a rate limit, a 401 a bad token, and a request that
  never arrived is the network - a second host improves none of those and its
  answer would replace a message the user can act on. When the fallback fails
  too, the _CDN's_ answer is the one reported: it recovered nothing, and reading
  the API's 404 as "this repo has no registry" would send the user off to check
  their `--repo` in the middle of a GitHub outage. Nor does a 200 that is not
  the file: asked with anything but that media type, the contents endpoint
  answers an envelope _about_ the file whose `name` is the file's own name, so
  `normalize` would read one as a marketplace called `marketplace.json` holding
  no plugins and `downloadPath` would write it over a plugin file byte for byte.
  A proxy that rewrites `Accept` is how one arrives, so `carriesJson` checks the
  content type and refuses it rather than decoding it - anchored on
  `application/json`, because `application/vnd.github.raw+json` is a spelling of
  the raw type itself and a search for "json" refuses the file it just asked
  for. A response this program cannot ask (a stub) counts as the file. That
  guard is also what makes the media type safe to be wrong about: if GitHub ever
  drops the spelling we send, the fallback degrades to reporting the outage
  rather than to writing envelopes. No token is needed for either host; one is
  sent when the environment has it, because the anonymous API budget is 60
  requests an hour. The retry announces itself as a `raw-outage` event before
  the second request rather than after it - `test/infrastructure` pins that
  order, since the events alone do not - and on stderr, so a `--json` payload
  stays parseable; `downloadPath` folds it to one line per folder rather than
  one per blob in flight.

- **Reading an archive** (`infrastructure/archive/`): `download.ts` follows its
  own redirects - `redirect: 'manual'`, five hops, every `Location` checked,
  every redirect's body cancelled - because a hop is the only place the rule
  can be enforced and Node's own following would not. The rule is **no
  downgrade**: a hop must be http or https, and one from https may not land on
  http. Plain http is the user's to choose by typing it, never a server's to
  choose for them by redirecting an https download to it. It counts
  bytes as they arrive, since `codeload.github.com` answers chunked with no
  `content-length` at all, and gives up after thirty seconds of silence or ten
  minutes in total: this is the one request this program makes that can
  legitimately run for minutes. The idle timer is re-armed as each response's
  headers arrive, so the thirty seconds bound **one** wait rather than being
  shared out between DNS, TLS, six requests and the first byte - a
  `/archive/` link is answered by a server that builds the tarball before
  sending it, and a chain armed once called that a stall. No `Authorization` on any hop, to any host -
  `ghHeaders` is deliberately not reused, because attaching a token is the one
  thing it does. `zip.ts` reads from the tail (end-of-central-directory, Zip64
  when the locator is there, then one entry at a time through a positioned
  read) and `tar.ts` from the head; `index.ts` sniffs the first bytes and hands
  back one `ArchiveReader` either way, so everything above is format-blind.
  Neither holds an archive in memory. A zip's declared sizes are summed against
  `LIMITS.unpacked` **before** anything is inflated - the central directory is
  what makes a bomb refusable for free - and `maxOutputLength` plus the CRC
  catch a header that lied; a tarball has no such manifest, so its cap is a
  running count over the gunzip output, into a file rather than a Buffer. Both
  readers also check a declared length against the **file's own size** before
  allocating it, which is the one bound a lying header cannot get around: a
  payload larger than the archive holding it is impossible, and believing one
  bought a gigabyte of `Buffer` for a three-kilobyte tarball before the existing
  "is truncated" check disbelieved it. Only the compressed length and the local
  offset are read that way - an _uncompressed_ size larger than the file is what
  compression is for, and it is `LIMITS.entry` that bounds it. That one is per
  **file**, not per archive, and it is the bound a well-formed archive needs:
  both readers hold one whole entry in memory, so the running total alone let a
  single honest entry claim the entire gigabyte - a 200 KB zip declaring one, and
  nothing anywhere lying about anything. `tooLarge` in `reader.ts` is shared, so
  the two cannot bound the same thing differently. A
  link - symbolic or hard - is skipped and reported, not fatal, because
  `copyDir` carries links today and an archive of a folder that installs must
  not fail; a device node still ends the archive. The inflate bound is never
  below one: zlib refuses a bound of zero, and Python's `zipfile` deflates an
  empty file to two bytes, so a `.gitkeep` failed every archive it was in. The
  fetcher wraps the readers in the one try/catch that turns anything they did
  not check for - a Zip64 pointer past the file, a `mkdir` over a file - into
  a Failure rather than a stack trace. `zlib.crc32`
  would do the checksum and landed in Node 20.15, so the table is hand-rolled:
  Node 18 is the floor.
- **The workspace** (`paths.workspaceDir`): an archive is downloaded and
  unpacked under the state directory, not `os.tmpdir()`, which on Fedora and
  Arch is a tmpfs sized at half of RAM - and an archive may unpack to a
  gigabyte. A sibling of `marketplace/`, never its parent, so the guard that
  stops a plugin being copied over its own source still reads the two as
  different places. `openArchive` sweeps anything a day old on its way in, so a
  run that was killed mid-download leaks nothing permanently, and the session
  disposes of the rest.
- **A checkout of a whole repository** (`RepoHandle.checkout(null)`): `null` is
  the repository itself rather than a folder in it, which is what a repo that
  _is_ a plugin needs. Neither arm could express it before: `sparse-checkout
add ''` is an error, so the git arm turns the clone's sparseness off instead
  and the clone directory is the checkout - and it **remembers**, because a
  later `sparse-checkout add` would narrow the tree back down and take files
  out from under a directory the handle has already answered with, so once the
  tree is whole a folder is read off it rather than asked for. The API arm
  takes every blob, an empty prefix being exactly that.

- **`src/infrastructure/paths.ts`** resolves paths for the _target_ platform (`path.win32` /
  `path.posix` chosen by the `platform` override, not the host), so Windows paths are
  exactly assertable from Linux CI.

- **VS Code settings** (`src/infrastructure/vscode-settings.ts`) are JSONC. Edits are targeted string
  splices, never parse-and-reserialize, so user comments and formatting survive. A
  backup is taken before every mutation. Both entry points test for the path
  **as a key** (`namedAsKey`), never as a bare quoted string: the path also
  appears quoted when it is some other setting's _value_, which used to make
  `remove` report `unremovable` for an entry that was not there. And both
  distinguish the `"<key>": true` entry this tool writes (`entryFor`) from any
  other shape: `add` returns `conflict` rather than `already` for a
  hand-edited `"<key>": false`, because reporting "already registered" there is a
  green install of a plugin VS Code never loads, and splicing a second entry in
  would just leave a duplicate key.

- **Installing from a path or a repository** (`infrastructure/local-plugin.ts`,
  `infrastructure/local-marketplace.ts`, and `readPluginManifest` in
  `infrastructure/github-registry-client.ts`): reading what a source declares
  itself to be, and generating a marketplace for it. `readLocalPlugin` answers with the plugin a directory
  declares itself to be, or a `Failure` naming the path - and it is also where
  the overlap guard lives: `replaceDir` removes its destination before copying,
  so a source that _is_ a destination would be deleted before it was read and
  one containing a destination would be copied into itself. Both directions are
  refused, for every editor's destination and for the generated marketplace.
  That marketplace exists because `claude plugin install` only ever takes
  `<id>@<marketplace>`: `claude plugin marketplace add` accepts a directory, so
  one is written under the state dir - `CP_STATE_DIR` sandboxes it, which a test
  run registering a marketplace with the developer's real `claude` would
  otherwise not be. One shared marketplace, not one per plugin, so its registry
  is shared state and follows the record's rule: every row but the one being
  written rides through verbatim. What is written has to satisfy **Claude's own
  schema**, which is stricter than the file this tool once produced: `owner` is
  required and must be an object carrying a non-empty `name` - a string, a
  nameless object, a `name` that is not a string, or nothing at all has the whole
  file refused, and with it the marketplace - so on every Claude that enforces it
  (2.1.269 and 2.1.270 both do) an install from a path or a repository failed
  while Cursor and VS Code succeeded. `ownerFor` keeps a usable one already in the
  file, the way every other field rides through, and replaces one Claude would
  refuse; `name` is forced because this tool owns it. A field this schema gains
  later is the same class of bug, and only a real `claude` can find it - the
  unit tests drive a fake runner, so they assert the argv and never what Claude
  makes of the bytes. Staging happens in the action and only when
  Claude Code is actually a target, so a run that never touched it leaves no
  marketplace holding a plugin it never got - and the last plugin out takes the
  whole directory with it, since an empty generated marketplace is a row in
  `claude plugin marketplace list` offering nothing. A `github` source stages
  the same way from the checkout instead of from a folder the user has, which
  is the reason the fetch condition is a compound one: `needsSource` stays a
  fact about an editor, "this origin has to be staged" is the fact about the
  run, and the action combines them - otherwise a run asking only for Claude
  Code would fetch nothing and stage nothing.
  `readPluginManifest` is the same read over the network, sharing
  `types/plugin-manifest.ts` with the disk so the two boundaries cannot
  disagree about what a usable manifest is. It probes the three files in the
  same order and, only once none of them answered, asks whether the repository
  carries a marketplace registry instead - because pointing at a marketplace
  and spelling it as a plugin is the one wrong turn where the repository really
  is installable, through `--repo`. The ordinary install still costs one
  request.

### `src/harnesses/` - one editor's install strategy each

One class per editor implementing the `Harness`
interface (`name`, `title`, `detect`, `location`, `install`, `uninstall`,
`needsSource`). None of them prints, and none of them throws for anything the
user could fix: `install` answers with a `Result<InstallOutcome, Failure>` -
`installed` or `skipped` on the ok arm, and a `Failure` for an editor that
looked and could not. Only the Claude path has one of those (a marketplace
name another repository already holds, and `claude plugin install` failing),
and it is a returned failure precisely so telemetry reads it as `user`:
when those two were throws, the command's catch could not tell them from a
bug. `installed`/`skipped` are named for the same reason the uninstall
outcomes are - `false` invited being read as failure when it means the editor
was not there. Each reports what it did as a
`HarnessEvent` on `ctx.listener`, and `src/prompts/harness/` turns each one
into the line it has always been - which is what lets Claude Code's install
report five shell-outs without a silent stretch, and what keeps each line
where it was, since a warning that explains a wait is only useful before it.
The six lines both file-copying editors say are one template each in
`prompts/harness/editor.ts` with the title filled in, and the reload hints are
a `Record<HarnessName, ...>` there, so an editor added without one does not
compile. `location()` answers with a `DirectoryPath` (or, for Claude Code,
prose about `$PATH`) and the caller formats it: a harness cannot reach
`f.path`. `ctx.srcDir` is a `DirectoryPath` too, typed all the way from the
fetcher, so a copying harness needs no path arithmetic of its own.
`uninstall` returns
`'removed' | 'absent' | 'skipped' | 'failed'`, never a boolean — and every one
of those is a truthy string, so a caller must never test the result for truth.
Only `removed` is reported and tracked; `absent` also clears the target from
the manifest row, because "there was nothing there" means the _record_ drifted
and leaving it strands the plugin — unremovable, and failing every `update`.
`absent` is a **positive** finding and nothing else may be widened into it.
`skipped` is "could not look": an editor `detect` cannot find (Cursor's copy
lives inside Cursor's own root, so a missing root makes the path unverifiable —
VS Code's lives in this tool's state dir, which is why it needs no such gate),
the `claude` CLI off `PATH`, no marketplace name. `failed` is "looked and it
went wrong", including anything a harness throws. Both keep the row, with
`--force` as the user's only escape, but only `failed` fails the run: an editor
that was never there must not turn a clean uninstall into a non-zero exit, and
a real error must not exit 0. `'unremovable'` from
`infrastructure/vscode-settings.ts` is the one thing that is _not_ read as failure: with no plugin
files there is nothing for VS Code to load whatever the settings file still
says, so the outcome follows `had` and the leftover entry is warned about
instead — unmentioned it survives the uninstall and the next install reports
"Already registered" for an entry that never loads the plugin.
The Claude path asks `claude plugin list --json` rather
than matching on the failure text, compares **the plugin id alone** (the
marketplace half is whatever name Claude filed it under, so comparing the whole
`plugin@marketplace` would read an unresolved name as proof of absence) and
only at `SCOPE`, the one scope every install and uninstall names — excluding
only `OTHER_SCOPES`, so a scope word this build has never seen counts as
possibly ours. That is the invariant to hold on to: an unrecognised _anything_
from Claude — a row with no `id`, a marketplace it cannot name, a new scope
word — counts as unanswered, never as proof of absence. That is why the plugin
listing must be read **whole**: `listPlugins` in `infrastructure/claude-cli.ts`
returns null unless every row parsed, because absence is the only conclusion it is ever read for, and a
listing whose rows this build cannot parse (plain strings, an `id` renamed on
some rows) would otherwise look exactly like "nothing is installed".
`listMarketplaces` is the opposite — it filters junk rows, because one
unreadable marketplace must not hide the rest and the worst case there is
re-adding one. When `marketplace add` fails, whether anything is
registered is still an open question - an older CLI with no `--json` listing
fails `add` precisely because the marketplace is already there - and
`marketplace update` is what settles it: it answers non-zero for a name Claude
does not hold. So `add` and `update` failing together is the one proof
available that nothing is registered, and it is a `Failure` carrying what
Claude actually said. Reporting it as success is how a schema rejection became
a bare "plugin not found in marketplace", blaming the plugin for the
marketplace and leaving the real reason on a `--verbose` line. The refresh of
an entry the listing _did_ show is the opposite case and stays tolerant: there
the registration is known and only the copy is stale. `LOOKS_ABSENT`, the
fallback for a CLI too old to list as JSON, holds only phrases that cannot be
about anything but a plugin: anything built around "is not installed" also
matches `Marketplace 'plugin-marketplace' is not installed`, and `plugin
marketplace` is Claude's own subcommand wording. All of that policy lives in the
harness; talking to the binary does not. `infrastructure/claude-cli.ts` is the
only place `claude` argv is spelled and the only `claude ... --json` reader
(`listJson`), and it is where the whole-or-null rule for plugins and the
drop-junk rule for marketplaces are enforced - so the harness receives rows it
can trust or `null` for "the CLI could not answer", and never has to decide how
to parse. Its command methods return the `RunResult`, not a `Result`: a non-zero
exit from `claude` is evidence, not a failure to report, and which of "stale
local copy" or "no such plugin" it means is the harness's call from the exit code
and the output.
`harnesses/index.ts` is a `HarnessRegistry` over instances and holds nothing
else; the names and titles are static knowledge in `types/harness.ts`, so a
pure decision can say "Cursor" without importing the code that installs into
it - and a caller that only wants a title should read `TITLES` rather than
reach for a harness. `byName` is total over `HarnessName` - narrow a string
with `isHarnessName` first. Claude Code installs
through the `claude` CLI from the marketplace itself (`needsSource: false`); Cursor
and VS Code copy files and need the fetched source - as does Claude Code for a
`directory` origin, which is why a path or repo install stages the files before
the loop rather than asking a harness. The Claude path also removes the plugin
before installing it when the origin is a directory: `claude plugin list --json`
shows a plugin cached at `plugins/cache/<marketplace>/<id>/<version>`, so an
edited plugin whose manifest version did not move would re-install and
copy nothing. That call reports nothing, and its exit code is kept rather than
ignored: it is the one signal that tells a failed install whether the user's
previous copy is already gone, which is the only thing the hint after it can
say that no other line would. To add an editor, use the
`add-harness` skill (`.claude/skills/add-harness/`) - it lists the hand-written
editor names and CI steps the compiler cannot flag.

### `src/prompts/` - every string a user reads

One class per command (`InstallPrompts`, `UpdatePrompts`, ...) plus the shared
renderers: `terminal.ts` is the only writer and the only `console` in the
codebase, `format.ts` shortens paths and pads columns, `gaps.ts` and
`marketplace.ts` render what the manifest and the marketplace clients report,
`prompts/harness/` turns each `HarnessEvent` into the line it has always been,
and `prompter.ts` asks the questions. It may import `types/` and other prompts
modules, and nothing else: a prompts class renders and asks, it does not decide.

The reason a command's words are a class rather than a module of functions is
that all of them should be reachable from one place. So a listener is a member
too - **the marketplace listener comes from the prompts class of whoever owns
the call**, and there is exactly one route for it: the router hands
`RouterPrompts.marketplaceListener` to the install session, `update` and
`uninstall` use their own, and `list` and `doctor` - which render nothing
themselves, because their command turns a report into a table - take it as a
required constructor argument from that command. Importing
`announceMarketplace` at a call site instead is how three actions acquired a
voice they were not supposed to have, and the boundary lint cannot see it,
because what it bars is the other direction.

`unicodeSupported` and `colorEnabled` live in `terminal.ts` rather than
`infrastructure/environment.ts` for the same boundary reason: the glyphs are
built from them, and a prompts module may not reach into infrastructure.

### `src/actions/` - one command's whole flow

`install`, `uninstall`, `update`, `list`, `installed`, `doctor`, `telemetry`,
and `action-result.ts` for what they all answer with. An action may reach
everything except `commands/`, and it speaks **only** through its own prompts
class - never to `terminal.ts`, which the lint refuses by name. It decides
nothing a pure function could decide (that is `application/`) and knows nothing
about flags (that is the command).

The trust confirmation sits **above** `resolve`, not after it. Resolving an
archive means downloading it, so anywhere else that sentence would be untrue -
and it was already slightly untrue of a repository, whose manifest read is a
request. What it costs is that the banner naming the plugin comes after the
question, which is right: the question has only ever named the source, which is
the thing the user typed and the thing they are being asked to trust. What it
buys is that declining costs nothing at all, and that a directory the user
declined is never read - the failure for a path that does not exist would
otherwise be a message about the wrong thing entirely.

An archive is also the one source whose `resolve` does the fetching, so the
action sets `at = 'fetch'` around the transfer and back to `'resolve'` for the
manifest read: `stage` is the only thing a failure event carries, and a failed
200 MB download is not a failed manifest read. The manifest is read with
`readLocalPlugin`'s `describeAs`, so every message names the archive rather
than the workspace it was unpacked into - the same bug reading
`blob/main/tools/foo` as a folder once had. After that an archive **is** a
directory install: `mustStage`, `stageLocalPlugin`, `conflictFor`,
`recordInstall` and every harness need no arm for it.

`update` is the one action that drives another: it threads a single session
through every row so three plugins from one marketplace read the registry once,
and the install it delegates to speaks through the `InstallPrompts` that
`UpdatePrompts.installPrompts()` hands it - so whether a row is a line in the
grid or a full install report is one class's decision, taken once.

What a row is refreshed _from_ is `sourceFor`: a marketplace row keeps today's
path - its own brand, its own registry - and the other two hand the install a
`PluginSource` rebuilt from the key rather than an id to re-read. That
distinction is load-bearing: `parseSource('my-sdk')` against the run's
marketplace is a different plugin that happens to share a name, so a path row
whose id was passed as a string would install the wrong thing. The sources that
answer `unavailable` instead are a directory that is gone and an archive
**on this machine** that is gone, which is an
ordinary day for whoever is writing a plugin; a repository that cannot be read
fails its row like any other install, because a 404 and an outage are not
distinguishable from here and "your plugin's source is gone" must not be what
a bad network day says - and an archive at a URL is that same case, so it fails
rather than being reported. `unavailable` sends no event - nothing reached an
install, and its reason names a directory or a file.

One thing that follows from the record's keying and is worth knowing before
changing either: a plugin named by its own manifest can **rename itself**
between two updates, and a row is keyed by name as well as by source - so the
new name installs beside the old one and the old copy stays on disk, still
loaded by the editor. `update` says so rather than leaving it silent, and
cannot do more than say it: removing the old copy means deciding that two rows
sharing one source key are one install, which is a rule the record does not
have today. Re-running `install` by hand has always done the same thing; what
phase 4 changed is that `update` reaches it without anyone asking.

### `src/commands/` - flags in, telemetry events out

`args.ts` is a typed flag table - no oclif, no clack - and `parseArgs` answers
with a `Result`, so an unreadable command line is exit 2 rather than a throw.
`router.ts` is the one readable sequence that decides what happens in which
order: parse, configure the terminal from `--verbose` / `--quiet`, `--version`
(first, and deliberately - it must answer even when the rc file beside it is
broken), then the brand, then help, then dispatch, and a `finally` that flushes
telemetry so a whole `update` is one request. Each `<cmd>.ts` builds the events
for its command from the report the action returned, whether the run worked or
not, and hands them to the `EventSink`.

A command may not import `infrastructure/` at all, and may not reach
`terminal.ts` either: it speaks through a prompts class like everything else.

### `src/composition/` and `src/main.ts` - the root

`composition/index.ts` builds the version reader, the telemetry instance, the
manifest context, the telemetry settings, the per-run session and the event
sink; `composition/brand.ts` is the seam that hands both rc files to the pure
resolver; and `main.ts` hands the lot to the router. That indirection is not
ceremony - `commands/` may not import `infrastructure/`, so a service reaches a
command only this way, and `Services` itself is a port in `types/` so that the
router can take it without naming what implements it.

Every member of `Services` is a function rather than a value, because none of
them may run before the command line is understood: reading the version opens a
file, and `--version` has to answer anyway. The event sink is wrapped here, so
a sink that throws cannot fail a run that has already written its files - that
is a promise only one place can make. And the session takes its `notify` from
the caller: the root builds it, but the words it says on the way belong to
whoever owns the run.

Everything below takes the services it uses, in its constructor, and none of
them is optional. There is no `Deps` bag any more: a `RegistryClient`, a
`SourceFetcher`, a `ProcessRunner`, `HttpPorts`. A command receives them
through a narrow interface named for that command - `MachineServices` for
`doctor` - over the same `Services` object the router holds, so what it may
reach is what its own type says. `docs/layering-plan.md` is the
record of how the layering above got here, phase by phase, including the
findings each review round turned up - worth reading before moving anything
across a boundary, because several of these shapes are the second or third
attempt at the same problem.

### State

State is one file, `~/.context-plugins/installed.json`, in three layers:
`infrastructure/manifest-store.ts` is the bytes (read whole, written through a
rename), `types/installed-record.ts` is every rule about a row, and
`types/manifest-context.ts` is the file as a domain object over a
`ManifestStore` port - the read view, the lookups, and the only two writes this
program makes. Entries are keyed repo+plugin because the same plugin id can
exist in two marketplaces, and the repo half of that key is compared
case-insensitively through `RepoSlug.same`, the way GitHub reads a slug and the
way the Claude harness always has: the marketplace conflict check, `list`'s
installed marks and its gap-warning scope use the same comparison, because a
run whose halves disagree about `Acme/M` and `acme/m` writes a second row for a
plugin that is already installed and then cannot uninstall either by the
other's spelling. Folding that case also means a key can match _more than
one_ row - a manifest an older build wrote can hold both spellings - so
`ManifestContext` reads the rows a key matches as one row (`foldRows`: a later
row wins a field both set, target lists are unioned, this build's names first
and the foreign ones after). Every lookup and both writes go through that one
private method, because `upsert` and `remove` act on every matching row: read
one and write several and another row's targets leave with nothing naming
them, which is the one thing the uninstall summary may never do. `read()`
returns the sanitized entries plus what it could not show: `ignored`
(rows it dropped, with reasons) and `elided` (rows it listed without a target name
this build does not know); `upsert`/`remove` work on the raw file and carry every other row
through verbatim. An entry with zero known targets must be _dropped_ from the read
view, never kept as `targets: []` — `resolveTargets` reads an empty list as "every
harness", which is why `uninstall` classifies the row with `rowShape` before
touching it. (`resolveTargets` checks the names it was given before it reads
`all`, so `--targets all,emacs` reports the typo instead of quietly widening
to every editor.) A `list` — an array naming at least one target this build knows —
is shortened per target. `unusable` (no `targets`, or an empty one) is dropped
whole, but only when every editor was asked _and_ every one answered (`removed`
or `absent`), or on `--force`: an empty `targets` reads as "every harness", so
one editor's answer cannot settle it without stranding the copy another still
holds. `foreign` is a target list this build cannot read — a non-array shape,
_or_ an array naming only names it does not know — never rebuilt and only ever
dropped by an explicit `--force`. That second case is not hypothetical:
uninstalling Cursor from `['cursor','zed']` leaves `['zed']`, so a normal run
produces it, and calling that a `list` left a row nothing could ever drop while
`read()` filed it under `ignored` and `update` failed on it forever. The
summary therefore speaks about `rowLeft` — the row as _written_, not as found —
because a `list` shortened down to foreign names is stranded exactly like a row
that arrived that way, and saying nothing left the user needing a second
`--force` run nothing had mentioned. `update` skips an entry whose every
recorded editor is undetected rather than failing on it: refreshing a plugin
for an editor that is not installed is a no-op, and treating it as a failure
made such a row exit 1 forever. The same rule is why a row whose source has
left the machine is `unavailable` rather than `failed`, and why the row itself
stays on the record: the copy in the editor is still there, so forgetting it
would strand exactly what `uninstall` is for. `uninstall` catches per harness, so one editor's I/O failure
neither hides the others nor loses the removals already done; it records
`'failed'`, finishes the run, prints the summary, and only then throws — which
is also why the write is _not_ in a `finally` (that would let a write failure on
the success path pass silently). `summarizeUninstall` prints one line per thing
that happened and nothing that did not: no line may stand in for another, since
every earlier shape of it managed to assert a finding — "cleared the stale
record" over a `--force` that confirmed nothing, "nothing was changed" over a row
it had just shortened, and once over a demonstrable failure. "Are they
installed?" is the one question it may only ask when nothing changed, nothing
failed, and no row survived to explain itself. The `--force` hint names the
stuck targets themselves rather than echoing the run's `--targets`, so it can
never widen what the user asked for. Both the record write and every line of
that summary come from one pure `decideUninstall` over `UninstallFacts` in
`application/uninstall-decision.ts`, and
`test/application/uninstall-decision.test.ts` walks the whole space it is defined over -
every row shape x every outcome for every editor (including "not asked") x
`--force` - asserting the invariants rather than a handful of cases. That test
is the reason this stopped being a bug a review round rediscovers in a new
shape: add an outcome or a row shape and it will tell you which invariant the
new combination breaks. Keep new reporting logic inside `uninstallLines` so it
stays covered. Editor names in prose come from `everyEditor()`, never a
literal. `titlesOf` and `everyEditor` live in `types/harness.ts`, derived from
`TITLES` - a `Record<HarnessName, string>`, so a name added without a title does
not compile - and the install prompts, the help text, `actions/doctor.ts` and the
uninstall decision all use them, so adding a harness leaves only `CLAUDE.md` and
`package.json` to edit by hand.
Resolving a marketplace name never blocks correcting a record: `uninstall`
degrades a failed lookup to a warning when there _is_ a row (so `--force`
works offline, and after an upstream rename), and still throws when there is
not, because then the resolution error and its suggestion are the useful
answer. The same rule holds _within_ a row: `recordInstall` and
`applyUninstall` rebuild from the raw record (`findRaw` + `foreignTargets`), so
a target name or field belonging to a newer CLI survives a rewrite. Never write
a row back from the sanitized view — which is now hard to get wrong rather than
merely documented, because reading the raw row and rebuilding it happen inside
the two methods that own the write. Every command that
renders that view says what it left out: `installed` and `list` share
`gapWarnings` in `prompts/gaps.ts`, `update` prints its own grid line, `doctor` counts them
as a check — on stderr under `--json` so the payload stays parseable, and
silenced by `--quiet` like any other warning. `list` scopes its warnings to the
marketplace it is listing, which is why both gap types carry `repo`.

### Configuration

Configuration resolves flag → `CP_*` env → `.contextpluginsrc` (cwd, then home)
→ defaults. `application/brand-resolution.ts` does the deciding, purely, over rc
files `infrastructure/rc-file.ts` has already read; `composition/brand.ts` is only
the seam that joins them, and it sits in the composition root because joining a
reader to a decider is the one thing that layer is for. Both files are merged field by field rather than one
winning whole, or a project rc that sets only `telemetry` silently moves every
install in that directory to the built-in marketplace. `DEFAULTS` in
`types/brand.ts` holds the marketplace, ref, display name and the Mixpanel token
and host; `BIN`, beside it, is the published command name, which every message
that suggests a command interpolates rather than spelling out. There is no brand
profile and no way to embed this CLI: it is a command, not a library, so the
token in `DEFAULTS` is always this project's and `BrandTelemetry.token` is a
plain `string` — "telemetry is not configured" is a state nothing can reach, so
there is no branch for it.

### Telemetry

Telemetry (`src/infrastructure/telemetry-service.ts`, over `telemetry-state.ts` for
the id file and `mixpanel-client.ts` for the POST): `createTelemetry` queues, `flush`
sends once and returns the lines it would have printed, which `prompts/telemetry.ts`
renders - infrastructure never writes to the terminal.
Each command builds the events it fires and hands them to an
`EventSink` the composition root wrapped, so a sink that throws cannot fail a run that
has already written its files; a test passes its own sink and collects them in an array.
The router owns the one instance per process and flushes in a `finally`, which makes a
whole `update` one request. `telemetryStatus`
and `describeTelemetry` back both `doctor` and `telemetry status`; the id file is
minted lazily, so read-only commands leave nothing behind.

### The test seam

The test seam is constructor injection, everywhere, and what a test substitutes
is the same service production takes. There is no bag of optional hooks: a test
builds a `Wiring` (`test/install-fixture.ts`) - a `RegistryClient` over a stub
fetch, and a `SourceFetcher` that hands over a directory rather than cloning
one - and passes its own `EventSink` for the events. `registryOnly` is the
wiring for a run that never fetches a plugin, with the real fetcher behind it
so a test that unexpectedly reaches for one fails loudly instead of quietly
using a stub - and with `noArchives` on its archive arm, because that one would
otherwise succeed rather than fail, into the developer's own state directory.
That is also why `sourceFetcher` takes its workspace rather than defaulting one:
a fetcher that downloads is told where to put what it downloads, and the
composition root is what says where. `PathOpts` still carries `platform` / `env` / `home`, and
`HarnessOpts` adds the `ProcessRunner` - which is what lets a test drive the
Claude Code path with a fake `claude` rather than excluding it, and why finding
that binary and spawning it cannot read different environments.
An archive test takes one seam more: `archiveWiring` builds the **real**
fetcher with its workspace inside the sandboxed machine, because that is where
a download lands, and `test/archive-fixture.ts` writes the zips and tarballs by
hand - which is what lets the ones nobody ships on purpose (a name that climbs
out, a symlink, a lying checksum, an encrypted entry, no directory entries at
all) be written down rather than found, and keeps the repository free of binary
fixtures. `noArchives` is the other arm every non-archive fetcher stub carries:
loud rather than empty, for the reason `registryOnly` keeps the real fetcher
behind it.
`test/install-fixture.ts` holds the three convenience wrappers the
suite drives (`installPlugin`, `uninstallPlugin`, `updateAll`) - they were
`src/install.ts` until the router became the only caller a released build
has. The command options take `HarnessOpts`, not
`PathOpts`, because that value is forwarded straight to the harnesses; the
fixture checks it with `satisfies HarnessOpts` rather than an annotation, so a
field that no longer exists on that type is refused where it is written. That
is not hypothetical - when the harness seam moved from `run` to `runner`, the
inferred literal dropped the fake silently and one behavioural test caught it.
Tests build a sandboxed "machine" from env overrides
(`CP_STATE_DIR`, `CP_CURSOR_DIR`, `CP_VSCODE_USER_DIR`) and assert on real files.
Never touch the developer's real home directory in tests; never add I/O that
bypasses these seams.

## Decisions already made

- No zod or any runtime validation library: validators are hand-rolled.
- No oclif, no clack: the parser is a typed flag table in `commands/args.ts` and the
  prompt flow is `prompts/prompter.ts`; both were weighed against the org's apimatic-cli
  stack and rejected to keep the package dependency-free.
- `--help` and `doctor` resolve the brand before running, so a broken rc file blocks
  them and exits 2; `--version` answers first, and deliberately. That order is the
  router's, in one readable sequence, which is what makes it a decision rather than an
  accident of where the code sat.
