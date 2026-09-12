# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`context-plugins` installs plugins into Claude Code, Cursor, and VS Code with one
command - from a plugin marketplace (a GitHub repo carrying a
`.claude-plugin/marketplace.json` registry), from a directory on the machine
that is itself a plugin, or from a GitHub repository (or a folder inside one)
that is itself a plugin. Published to npm; users run it via `npx`. The README is end-user documentation
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
(`node bin/cli.js ...`) needs `npm run build` first; CI's smoke job does exactly that.

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
  `github` or `local`, `stage`, `error_kind`, `targets_explicit`, `duration_ms`) in step.
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
  branch name a user will type. `key()` is the manifest's `repo` column - a
  marketplace source's is the repo verbatim, so no record migrates, and the
  other two are prefixed `local:` / `github:` so they can never collide with a
  slug; a repository's folder is separated by `//`, which is what keeps two
  plugins out of one monorepo in two rows. `restoreSource` reads that column
  back into a source and is **total**: a key this build cannot parse is a
  marketplace repo, because a row that no command could reach is worse than a
  row that reads oddly. `sourceKindOf` is the same question for a caller that
  only needs to branch. A repository's folder is validated here the way an id
  and a ref are, and for the same reason: it reaches `git sparse-checkout add`
  as argv, where a leading `-` is an option, and a raw.githubusercontent.com
  URL as a path, where a `?` or a `#` truncates the request and some other file
  would be read as the manifest. It is pure: whether a directory or a repository really
  holds a plugin is a question for `infrastructure/local-plugin.ts` and
  `readPluginManifest`, which go and look.
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

Fourteen modules over the file system, the network, the process table, the
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
  written rides through verbatim. Staging happens in the action and only when
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
re-adding one. `LOOKS_ABSENT`, the
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
whose id was passed as a string would install the wrong thing. The one source
that answers `unavailable` instead is a directory that is gone, which is an
ordinary day for whoever is writing a plugin; a repository that cannot be read
fails its row like any other install, because a 404 and an outage are not
distinguishable from here and "your plugin's source is gone" must not be what
a bad network day says. `unavailable` sends no event - nothing reached an
install, and its reason names a directory.

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
using a stub. `PathOpts` still carries `platform` / `env` / `home`, and
`HarnessOpts` adds the `ProcessRunner` - which is what lets a test drive the
Claude Code path with a fake `claude` rather than excluding it, and why finding
that binary and spawning it cannot read different environments.
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
