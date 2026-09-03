# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`context-plugins` installs plugins from a plugin marketplace (a GitHub repo carrying a
`.claude-plugin/marketplace.json` registry) into Claude Code, Cursor, and VS Code with one
command. Published to npm; users run it via `npx`. The README is end-user documentation
only, by explicit decision — contributor and agent knowledge belongs here, not there.

## Commands

- `npm test` — full suite; `npx tsx --test test/manifest.test.ts` runs one file
- `npm run typecheck` — strict `tsc` over `src/` and `test/`, no output
- `npm run build` — emits `lib/` (gitignored; `prepare` builds it for publish, for a
  git-URL install, and after a plain `npm ci`)
- `npm run lint` / `npm run lint:fix` — eslint 9 flat config, typescript-eslint, sonarjs bug rules
- `npm run format:check` / `npm run format` — prettier
- `npm run syntax` — bare `node --check` of the plain-JS entry points

Tests run the TypeScript in `src/` directly through tsx — there is no build in the loop, on
purpose. `bin/cli.js` and `run.js` require the compiled `lib/`, so exercising the real
entry point (`node bin/cli.js ...`) needs `npm run build` first; CI's smoke job does exactly
that.

## Hard constraints

- **Zero runtime dependencies, ever.** This is the package's identity: `npx` starts
  instantly, the shipped source is auditable, and the supply-chain surface is nil.
  Hand-roll instead of installing (see `which()`, `pool()`, the boundary validators).
  devDependencies are fine; nothing goes under `dependencies`.
- **Commit types are release decisions.** semantic-release publishes to npm from commit
  messages: `fix:` / `feat:` / `perf:` trigger a release; `refactor:` / `chore:` /
  `docs:` / `style:` do not. commitlint enforces conventional commits on every PR.
- **Never `shell: true`.** Spawning goes through `util.run()`, which routes Windows
  `.cmd` shims through cmd.exe with explicit quoting (Node refuses to spawn `.cmd`
  directly since the CVE-2024-27980 hardening).
- **All terminal output goes through `src/log.ts`** — no `console.log` elsewhere.
  Glyphs are built from char codes with ASCII fallbacks for legacy Windows consoles;
  keep the source itself ASCII, escaping any character that must not be normalised
  (`\u00a0` in `toAscii` — the port lost that one to an editor once already).
  `debug` and `warnStderr` write to stderr so `--json` output stays parseable; anything
  a `--json` path emits alongside the payload has to use them.
- **Validate at the edges, never cast.** Anything crossing a JSON boundary (manifest,
  registry, rc file, `claude` CLI output, GitHub API responses) or entering argv/URLs
  (plugin, repo, ref) is validated where it enters, with `isPlainObject` /
  `nonEmptyString` from `util.ts`. `as` on parsed JSON is the anti-pattern. The
  manifest drops bad entries from its read view but never from disk (it is shared
  state; a newer CLI may own a row); the rc file fails loudly naming the file (it is
  user-written configuration). Keep that split.
- **Node 18 is the engine floor**, and `@types/node` is pinned to 18 so the compiler
  cannot let a newer API in. tsx is the price of running TypeScript tests on 18/20.
- **TypeScript stays on 6.x** until typescript-eslint's peer range admits 7 (`<6.1`
  today). TypeScript 7 is also what breaks eslint-plugin-sonarjs v2+, which is why
  sonarjs is pinned to v1.
- **Telemetry is anonymous, flat, and optional.** Events leave only through
  `src/telemetry.ts`, in one POST to Mixpanel's `/track` at the end of `cli.run`
  (`ip=0`, so no geolocation), bounded by a timeout and never allowed to fail or hold
  a run. The project token in `brand.ts` is a public routing key, not a secret; the
  project is US-resident, so the host stays `api.mixpanel.com`. Properties are
  primitives only, and `COLLECTED` in `telemetry.ts` is the one prose inventory the
  notice and `telemetry status` print; keep it, `common`, and install.ts's per-event
  properties (`plugin` once validated, `harness`, `marketplace` as the built-in repo or
  `custom`, `stage`, `error_kind`, `targets_explicit`, `duration_ms`) in step. Never send
  a path, hostname, username, error message, env var, or a user-supplied `--repo`.
  Opt-out precedence is `DO_NOT_TRACK`, `CP_TELEMETRY=off`, rc `"telemetry": false` in
  _either_ rc file, then the state file, which fails closed: a `telemetry.json` that
  exists but cannot be read or parsed disables telemetry rather than being replaced, and
  `enabled: false` is honoured even without an id. If the state directory cannot be
  written, nothing is sent (no stable id, and the notice would repeat).
  `CP_TELEMETRY=log` prints the payload instead of sending it. The one-time notice and
  the log mode go to stderr through `log.notice`, which ignores `--quiet` on purpose.
  `createTelemetry` does no I/O and never dereferences global `fetch`; everything is
  resolved in `flush`, only once something was tracked. Tests never reach the network:
  `scripts/test.js` sets `CP_TELEMETRY=off`, the CI smoke job does too, and
  install/uninstall report through the `deps.track` seam, wrapped so a throwing sink
  cannot fail a run.

## Architecture

Every command flows `bin/cli.js` → `src/cli.ts` (arg parsing and rendering only) →
`src/install.ts` (orchestration) → the harness that owns each editor. `src/types.ts`
is the type model for the whole surface; keep it in sync when behavior changes.

- **Harnesses** (`src/harness/`): one module per editor implementing the `Harness`
  interface (`name`, `title`, `detect`, `location`, `install`, `uninstall`,
  `needsSource`). `uninstall` returns
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
  `settings-merge` is the one thing that is _not_ read as failure: with no plugin
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
  listing must be read **whole**: `installedPlugins` returns null unless every
  row parsed, because absence is the only conclusion it is ever read for, and a
  listing whose rows this build cannot parse (plain strings, an `id` renamed on
  some rows) would otherwise look exactly like "nothing is installed".
  `listMarketplaces` is the opposite — it filters junk rows, because one
  unreadable marketplace must not hide the rest and the worst case there is
  re-adding one. `LOOKS_ABSENT`, the
  fallback for a CLI too old to list as JSON, holds only phrases that cannot be
  about anything but a plugin: anything built around "is not installed" also
  matches `Marketplace 'plugin-marketplace' is not installed`, and `plugin
marketplace` is Claude's own subcommand wording. `listJson` is the single validated boundary for every
  `claude ... --json` read.
  `harness/index.ts` is the registry, and `byName` is total over
  `HarnessName` - narrow a string with `isHarnessName` first. Claude Code installs
  through the `claude` CLI from the marketplace itself (`needsSource: false`); Cursor
  and VS Code copy files and need the fetched source. To add an editor, use the
  `add-harness` skill (`.claude/skills/add-harness/`) - it lists the hand-written
  editor names and CI steps the compiler cannot flag.
- **Session** (`src/session.ts`): work shared by every plugin in one run — the
  registry fetch, the repo clone, the Claude marketplace registration — each done
  once, keyed `repo@ref`. Promises are cached rather than results, so concurrent
  callers share one request and a deterministic failure is not retried. `update`
  threads one session through all plugins; a lone `install` gets a throwaway one.
- **The test seam is dependency injection, everywhere.** `Deps` carries
  `fetchImpl` / `run` / `materialize` / `confirm`; `PathOpts` carries
  `platform` / `env` / `home`. The command options take `HarnessOpts`, not
  `PathOpts`, because that value is forwarded straight to the harnesses — which
  is what lets a test drive the Claude Code path with a fake `claude` rather than
  excluding it. Tests build a sandboxed "machine" from env overrides
  (`CP_STATE_DIR`, `CP_CURSOR_DIR`, `CP_VSCODE_USER_DIR`) and assert on real files.
  Never touch the developer's real home directory in tests; never add I/O that
  bypasses these seams.
- **`src/paths.ts`** resolves paths for the _target_ platform (`path.win32` /
  `path.posix` chosen by the `platform` override, not the host), so Windows paths are
  exactly assertable from Linux CI.
- **State** is one file, `~/.context-plugins/installed.json` (`src/manifest.ts`),
  entries keyed repo+plugin because the same plugin id can exist in two marketplaces.
  `read()` returns the sanitized entries plus what it could not show: `ignored`
  (rows it dropped, with reasons) and `elided` (rows it listed without a target name
  this build does not know); `upsert`/`remove` work on the raw file and carry every other row
  through verbatim. An entry with zero known targets must be _dropped_ from the read
  view, never kept as `targets: []` — `resolveTargets` reads an empty list as "every
  harness", which is why `uninstall` classifies the row with `rowShape` before
  touching it. A `list` — an array naming at least one target this build knows —
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
  made such a row exit 1 forever. `uninstall` catches per harness, so one editor's I/O failure
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
  never widen what the user asked for. Editor names in prose come from `everyEditor()`, never a
  literal. `titlesOf` and `everyEditor` live in `harness/index.ts`, next to
  `NAMES` and `byName`, and `install.ts`, `cli.ts` and `doctor.ts` all use them,
  so adding a harness leaves only `CLAUDE.md` and `package.json` to edit by hand.
  Resolving a marketplace name never blocks correcting a record: `uninstall`
  degrades a failed lookup to a warning when there _is_ a row (so `--force`
  works offline, and after an upstream rename), and still throws when there is
  not, because then the resolution error and its suggestion are the useful
  answer. The same rule holds _within_ a row: writers rebuild from the raw record
  (`findRaw` + `foreignTargets`), so a target name or field belonging to a newer CLI
  survives a rewrite. Never write a row back from the sanitized view. Every command that
  renders that view says what it left out: `installed` and `list` share
  `gapWarnings` in `cli.ts`, `update` prints its own grid line, `doctor` counts them
  as a check — on stderr under `--json` so the payload stays parseable, and
  silenced by `--quiet` like any other warning. `list` scopes its warnings to the
  marketplace it is listing, which is why both gap types carry `repo`.
- **VS Code settings** (`src/settings-merge.ts`) are JSONC. Edits are targeted string
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
- **Configuration** resolves flag → `CP_*` env → `.contextpluginsrc` (cwd, then home)
  → preset profile → defaults (`src/brand.ts`). `run.js` exists so another brand can
  ship this CLI preconfigured. The Mixpanel token and host are profile fields
  (`telemetryToken`, `telemetryHost`). Telemetry is opt-in for brands: a profile that
  names its own `repo` gets no token unless it also sets one, because the default token
  is this project's and must not collect on another's behalf. A profile that keeps the
  default marketplace inherits it.
- **Telemetry** (`src/telemetry.ts`): `createTelemetry` queues, `flush` sends once.
  `install.ts` reports through `deps.track`, so library callers never phone home and a
  test captures events with an array. `cli.run` owns the one instance per process and
  flushes in a `finally`, which makes a whole `update` one request. `telemetryStatus`
  and `describeTelemetry` back both `doctor` and `telemetry status`; the id file is
  minted lazily, so read-only commands leave nothing behind.

## Decisions already made

- No zod or any runtime validation library: validators are hand-rolled.
- No oclif, no clack: the parser is a typed flag table in `cli.ts` and the prompt flow
  is `prompt.ts`; both were weighed against the org's apimatic-cli stack and rejected
  to keep the package dependency-free.
- `--help` and `doctor` still resolve the brand before running, so a broken rc file
  blocks them; `--version` does not. Restructuring that is open work.
