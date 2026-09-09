# context-plugins Install-by-Path Plan

Teaching `install` two more origins - a directory on disk, and a GitHub repo or
subdirectory that _is_ a plugin - without a new flag, a new dependency, or any change to
how a marketplace install behaves.

All five phases land on one branch, `saeedjamshaid/install-by-path`, as a single pull
request against `main`. The phase is the unit of review; phase 1 is a `refactor:` that
publishes nothing, phases 2-4 are the `feat:` releases, phase 5 is `docs:`.

| Date       | Base             | Verified against | Scope                                     |
| ---------- | ---------------- | ---------------- | ----------------------------------------- |
| 2026-09-09 | `main @ f9d4d9a` | claude 2.1.266   | `install`, `uninstall`, `update`, records |

Contents

1. [Decisions already made](#decisions-already-made)
2. [What the user types](#what-the-user-types)
3. [Where the fork lands](#where-the-fork-lands)
4. [The two new value objects](#the-two-new-value-objects)
5. [Where a path plugin's id comes from](#where-a-path-plugins-id-comes-from)
6. [Claude Code: a marketplace we generate](#claude-code-a-marketplace-we-generate)
7. [State: one key, three origins](#state-one-key-three-origins)
8. [Per command](#per-command)
9. [Telemetry](#telemetry)
10. [Guards](#guards)
11. [File map](#file-map)
12. [Test map](#test-map)
13. [Phases](#phases)
14. [Open items](#open-items)
15. [Out of scope](#out-of-scope)

## Decisions already made

These were settled before the plan was written. Everything below assumes them; change one
and the affected phase changes with it.

| Decision      | Choice                                       | Why                                                                                                  |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Sources       | Local dir, GitHub repo, GitHub subdir        | The three the dev loop and third-party plugins actually need.                                        |
| Claude Code   | One synthesized local marketplace            | `claude plugin install` only ever takes `<id>@<marketplace>`, so a path plugin needs one to exist.   |
| Surface       | Positional, auto-detected                    | A plugin id can never hold `/`, `.`, `~` or a drive letter, so no flag is needed to tell them apart. |
| Local install | Snapshot copy                                | The same thing Cursor and VS Code harnesses already do. `--link` is a separate feature.              |
| Plugin id     | From the plugin manifest only                | A folder name can disagree with what Claude Code files the plugin under.                             |
| `update`      | Re-sync; warned skip when the source is gone | A moved dev folder must not fail every `update` forever.                                             |
| Telemetry     | New `source_kind`; no id for a local source  | A private folder's plugin name is not a public plugin name.                                          |
| Trust         | Confirm once, unless `-y`                    | A plugin from an arbitrary path can carry hooks and MCP servers that run commands.                   |

## What the user types

A plugin id is kebab-case and can never hold `/`, `.`, `~` or a drive letter, so the three
kinds are distinguishable without a flag. The parser tries `PluginId` **first**, which is
what guarantees nothing about today's usage moves. `src/commands/args.ts` is untouched.

| Argument                                               | Kind        | Repo             | Ref          | Files                   |
| ------------------------------------------------------ | ----------- | ---------------- | ------------ | ----------------------- |
| `paypal`                                               | marketplace | from `--repo`    | from `--ref` | the registry's `source` |
| `./my-plugin`, `../x`, `/opt/x`, `~/dev/x`, `C:\dev\x` | local       | -                | -            | the directory itself    |
| `acme/my-plugin`                                       | github      | `acme/my-plugin` | from `--ref` | repo root               |
| `acme/my-plugin@v1.2`                                  | github      | `acme/my-plugin` | `v1.2`       | repo root               |
| `acme/mono/tools/foo`                                  | github      | `acme/mono`      | from `--ref` | `tools/foo`             |
| `https://github.com/acme/mono/tree/v2/tools/foo`       | github      | `acme/mono`      | `v2`         | `tools/foo`             |
| `git@github.com:acme/x.git`                            | github      | `acme/x`         | from `--ref` | repo root               |

An inline `@ref` wins over `--ref`, which wins over `brand.ref` - the existing precedence,
extended by one step. When both are given and differ, say so, the way
`prompts.targetsIgnored` already does for a flag a command cannot use: a silently ignored
flag is the one thing that reads as the user having chosen it.

A marketplace is still only ever named by `--repo` / `CP_REPO` / rc. A positional
`owner/repo` is always a plugin, never a marketplace - which is what keeps the two
spellings from ever meaning the same thing.

Everything else is a `Failure` naming both shapes it could have been - a kebab-case id, or
a path or repo - on the failed arm, never a throw. Nothing here is a problem the user
cannot fix.

## Where the fork lands

The four stages below are not a diagram invented for this document: they are
`InstallStage` in `src/types/reports.ts`, the values a failure event already reports. Only
the first one forks. Everything after it is told _where the files are_ and _what
marketplace name to address_, and neither of those has to know how the answer was reached.

| Stage       | What changes                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `resolve`   | **Forks here.** A marketplace id reads the registry as today. A path or repo reads the plugin's own manifest instead.               |
| `harnesses` | Unchanged, except that `needsSource` now depends on the marketplace kind rather than being a constant per editor.                   |
| `fetch`     | A local source skips it - the files are already on disk. A github source reuses the session's clone, with a new root-checkout case. |
| `install`   | Cursor and VS Code copy, as always. Claude Code installs from a marketplace - the one we generated, when there is no registry.      |

## The two new value objects

Both live in `src/types/`, import nothing above it, and do no I/O - which is what lets the
parser be a pure table test over every spelling above.

```ts
// src/types/plugin-source.ts - what the user asked for, validated once.
type PluginSource =
  | { kind: 'marketplace'; plugin: PluginId; repo: RepoSlug; ref: GitRef }
  | { kind: 'github'; repo: RepoSlug; ref: GitRef; path: string | null }
  | { kind: 'local'; dir: DirectoryPath };

// parse(spec, { cwd, home, ref }) -> Result<PluginSource, Failure>
// key()          -> the manifest's `repo` column, round-trips through restore()
// restore(key)   -> a source back out of a recorded row, for update / uninstall
// reportableId() -> PluginId | null, so no command can leak a local id

// src/types/marketplace-origin.ts - how Claude Code will address it. The
// vocabulary is `claude plugin marketplace list --json`'s own.
type MarketplaceOrigin =
  | { kind: 'repo'; name: string; repo: string }
  | { kind: 'directory'; name: string; dir: DirectoryPath };
```

`MarketplaceOrigin` replaces the `marketplace: string | null` and `repo: string` pair on
`HarnessContext`. One value instead of two that can disagree, and the Claude harness's
whole policy question - "which name is this filed under?" - becomes a switch on its
`kind`.

`cwd` joins `platform`, `env` and `home` on `PathOpts` for the same reason those are
there: a test must never resolve a relative path against the developer's real directory.

## Where a path plugin's id comes from

A registry supplies both the id and its `source` path. A directory supplies neither, and
the id is load-bearing three times over: it names the destination folder under Cursor and
VS Code, it is half the manifest key, and it is the left half of `<plugin>@<marketplace>`.
So it comes from the plugin's own manifest and nowhere else - never the folder name, which
can disagree with what Claude Code files it under.

Probed in order: `.claude-plugin/plugin.json`, then `.cursor-plugin/plugin.json`, then a
bare `plugin.json`. The first one carrying a `name` that validates as a `PluginId` wins.
None of them, and the run fails naming the three paths it looked at.

Parsing that JSON is pure, so it goes in `src/types/plugin-manifest.ts` beside `normalize`
in `types/catalog.ts` - one definition of a plugin manifest, read by two boundaries: a new
`infrastructure/local-plugin.ts` for the disk, and a new `readPluginManifest` in
`infrastructure/github-registry-client.ts` for the network, which inherits the two-host
raw/API fallback and its outage messages for free.

When a repo has no plugin manifest but _does_ have `.claude-plugin/marketplace.json`, the
user pointed at a marketplace and spelled it as a plugin. That is worth its own hint -
`--repo acme/x install <plugin>`, and `list` to see what it offers - rather than a bare
"no manifest here".

## Claude Code: a marketplace we generate

`claude plugin install` only ever takes `<id>@<marketplace>`. A path plugin has no
marketplace, so we write one: a directory under this tool's own state dir, which
`claude plugin marketplace add` accepts as a source. Confirmed against the CLI on the
machine this was planned on, v2.1.266 - `marketplace add` is documented as "from a URL,
path, or GitHub repo", and a directory marketplace lists back as
`{ name, source: "directory", path, installLocation }`.

```
~/.context-plugins/marketplace/       <- paths.localMarketplaceDir()
  .claude-plugin/marketplace.json     { name: "context-plugins-local", plugins: [...] }
  plugins/<id>/                       <- replaceDir() from the resolved source
```

One shared marketplace, not one per plugin, so `claude plugin marketplace list` gains
exactly one row however many path plugins are installed. Its name is a constant beside
`BIN` in `types/brand.ts`, chosen so it cannot collide with a marketplace a user added by
hand. The registry file is read-modify-written atomically and carries rows for every other
plugin through verbatim - the same rule the manifest already follows, and for the same
reason: it is shared state on disk that a hand edit can reach.

**Why a path install must uninstall first.** Evidence from `claude plugin list --json`: a
plugin is cached at `plugins/cache/<marketplace>/<id>/<version>`, keyed by the `version`
its manifest declares. A developer who edits a local plugin without bumping that version
would get a re-install that copies nothing. So for a `directory` marketplace only, the
harness runs `plugin uninstall` (result ignored - absence is fine), then
`marketplace update`, then `plugin install`. Deterministic regardless of the version. The
registry path keeps today's argv exactly.

What else the harness has to learn:

- `needsSource` becomes `needsSource(marketplace)`: `true` for Cursor and VS Code, and
  `marketplace.kind === 'directory'` for Claude Code. An honest signature - whether the
  files are needed genuinely depends on where the marketplace is - and it keeps the
  special case out of the action.
- `isSameRepo` gains a directory arm: match `source === 'directory'` and `path` against
  our generated dir. The existing `repoOf` already answers `null` for such a row, so
  today's fallback would compare it by JSON substring - correct by luck, and worth making
  deliberate.
- Everything else is untouched: `SCOPE`, `OTHER_SCOPES`, the whole-or-null plugin listing,
  `LOOKS_ABSENT`, the stale-marketplace retry. `-y` is **not** added: in v2.1.266 it gates
  only command-source and `headersHelper` plugins, and an unknown flag on an older CLI
  would fail the whole call.

## State: one key, three origins

The manifest is keyed `plugin` + `repo`. Rather than add a parallel key field that every
lookup would have to learn, the `repo` column holds `PluginSource.key()` - and a
marketplace row's key is unchanged, so every record written by every released build still
reads correctly. There is no migration.

| Kind        | `repo` on the row             | Consequence                                   |
| ----------- | ----------------------------- | --------------------------------------------- |
| marketplace | `acme/plugin-marketplace`     | Byte-identical to today.                      |
| github      | `github:acme/mono//tools/foo` | Two plugins from one repo stay distinct rows. |
| local       | `local:C:\dev\my-plugin`      | Absolute, as resolved at install time.        |

`RepoSlug.same` case-folds this column, which is right for a GitHub slug and right for a
Windows or macOS path. On Linux two local paths differing only in case would fold together

- documented, not fixed, because the alternative is a second comparison rule the two
  halves of a run could disagree about, which is exactly what the case-folding was
  introduced to end.

`conflictFor` now also catches `install ./paypal` when `paypal` is already installed from
the built-in marketplace - they share a destination folder under Cursor and VS Code. Its
sentence widens from "a different marketplace" to "a different source"; the rule and the
`--force` escape are unchanged.

## Per command

| Command     | Change                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`   | Parses the spec at `resolve`. Confirms a non-marketplace source once, before anything is fetched or copied, through the existing `Ask` seam - `--yes` skips it, and a non-interactive shell prints the resolved source and proceeds, the way `nobodyToAsk` already does. A cancel is `ActionResult.cancelled`, so exit 130 and the session still cleans up. |
| `uninstall` | Skips the registry lookup entirely for a path origin - there is nothing to look up, and the row's recorded `marketplace` is already what keeps this offline. The Claude arm addresses the generated marketplace; when its last plugin leaves, the generated directory and its `claude` registration go too.                                                 |
| `update`    | Branches on `PluginSource.restore(row.repo)`. A github row re-fetches at its recorded ref; a local row re-reads its directory. A source that has vanished - or an origin scheme this build cannot parse - is a warned skip, never a failure.                                                                                                                |
| `installed` | Renders the origin: a slug as today, or a local path shortened through `f.path`. `--json` keeps its shape; `repo` simply carries the new key.                                                                                                                                                                                                               |
| `list`      | Nothing. It lists a marketplace catalog; a path row's key never matches one, so its installed marks and gap warnings stay correctly scoped.                                                                                                                                                                                                                 |
| `doctor`    | Nothing required. Worth one check later: a generated marketplace holding an entry whose folder is gone.                                                                                                                                                                                                                                                     |

**A fifth `UpdatedRow` arm.** The four arms in `types/reports.ts` exist because which
facts survive depends on how far a row got, and a command must not have to guess. A
vanished source is a fifth case with its own facts: `{ outcome: 'unavailable'; plugin;
reason }`, reported and warned but not counted as failure, so the run still exits 0.
Reusing `skipped` would lose the reason, and `unreadable` would exit 1 for a folder the
user simply moved - which is the shape of bug this repo has already fixed twice.

## Telemetry

The rule the codebase already holds: never a path, a hostname, a username, an error
message, or a user-supplied `--repo`. This feature is exactly the kind that erodes it, so
the delta is small and stated.

| Property            | marketplace                | github   | local    |
| ------------------- | -------------------------- | -------- | -------- |
| `source_kind` (new) | `marketplace`              | `github` | `local`  |
| `plugin`            | the id                     | the id   | `null`   |
| `marketplace`       | built-in name, or `custom` | `custom` | `custom` |

A private folder's plugin name is not a public plugin name, so a local install sends no
id. The decision lives in `PluginSource.reportableId()`, not in a command - a command that
had to remember would eventually forget. `MarketplaceLabel.of` is untouched: it reads
`brand`, and `brand` has not changed.

`source_kind` rides on all four plugin events, typed as a union rather than a free string.
`COLLECTED` in `types/telemetry.ts` gains a clause for it and a sentence saying the id is
withheld for a local source - that prose is what the one-time notice and
`telemetry status` print, so it has to stay true.

## Guards

| Situation                                                             | Answer                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install ~/.cursor/plugins/local/foo` - the source _is_ a destination | `replaceDir` is `rmrf` then copy, so this deletes the source before reading it. A `Failure` when the source and any install destination overlap in either direction, checked with `DirectoryPath.contains`. |
| A repo root checkout                                                  | `sparse-checkout add ''` and a blob prefix of `'/'` both break today. `RepoHandle.checkout` takes `string \| null`: the git arm disables sparse and uses the clone itself, the API arm takes every blob.    |
| A whole repo is large                                                 | The tree read already reports `truncated`, and the existing event says so before the download. `marketplace add --sparse` exists but is not needed - we never hand Claude a remote repo.                    |
| A local path with spaces, on Windows                                  | It reaches `claude` as argv through `run()`, which already routes `.cmd` shims through cmd.exe with explicit quoting. Worth one case in the CI smoke job.                                                   |
| A file, a missing dir, an empty dir                                   | Each a distinct `Failure` from `local-plugin.ts` naming the path. Never a throw - every one of these is a problem the user can fix.                                                                         |
| A `~` the shell did not expand                                        | Expanded against `home`, which the parser is given rather than reads.                                                                                                                                       |

## File map

Every new module sits in a layer the lint already has a rule for, so
`test/layering.test.ts` needs no change. Nothing goes under `dependencies`.

| File                                                              | Change | What for                                                                          |
| ----------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `types/plugin-source.ts`                                          | new    | The union, the parser, `key`/`restore`, `reportableId`.                           |
| `types/marketplace-origin.ts`                                     | new    | Repo or directory, in Claude's own vocabulary.                                    |
| `types/plugin-manifest.ts`                                        | new    | One reader for `plugin.json`, shared by both boundaries.                          |
| `infrastructure/local-plugin.ts`                                  | new    | Probe a directory, validate it, guard the overlap.                                |
| `infrastructure/local-marketplace.ts`                             | new    | Stage and unstage the generated registry, atomically.                             |
| `types/harness.ts`                                                | edit   | `HarnessContext` takes a `MarketplaceOrigin`; `needsSource` becomes a method.     |
| `types/session.ts`, `infrastructure/session.ts`                   | edit   | A memoized `manifest()` read beside `catalog()`; `checkout` accepts `null`.       |
| `types/catalog.ts`, `application/plugin-resolution.ts`            | edit   | `ResolvedPlugin` carries a source and an origin instead of a repo and a ref.      |
| `types/reports.ts`                                                | edit   | The `unavailable` row; `ref` becomes nullable for a local install.                |
| `types/telemetry.ts`, `types/events/*.ts`                         | edit   | `source_kind`, a nullable `plugin`, and the `COLLECTED` prose.                    |
| `types/env.ts`                                                    | edit   | `cwd` on `PathOpts`.                                                              |
| `infrastructure/paths.ts`                                         | edit   | `localMarketplaceDir` under `stateDir`, so `CP_STATE_DIR` sandboxes it.           |
| `infrastructure/source-fetcher.ts`                                | edit   | Root checkout in both the git and the API arm.                                    |
| `infrastructure/github-registry-client.ts`                        | edit   | `readPluginManifest`, over the same two-host fallback.                            |
| `harnesses/claude.ts`                                             | edit   | The directory-marketplace arm, and uninstall-before-install for it.               |
| `actions/install.ts`, `update.ts`, `uninstall.ts`                 | edit   | Parse the spec, branch per kind, confirm the source once.                         |
| `prompts/install.ts`, `uninstall.ts`, `update.ts`, `installed.ts` | edit   | The trust question, the source in the intro and summary, the origin in the table. |
| `commands/help.ts`, `README.md`                                   | edit   | The new spellings, and the examples.                                              |

## Test map

| Test                                            | What it holds                                                                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/types/plugin-source.test.ts`              | The parser as a table over every spelling and every rejection, plus the `key`/`restore` round trip and the drive-letter and `~` cases, driven by `platform` and `home` overrides the way `paths.test.ts` already is.                |
| `test/types/plugin-manifest.test.ts`            | The three probe locations, a name that does not validate, a missing name.                                                                                                                                                           |
| `test/infrastructure/local-plugin.test.ts`      | A file, a missing dir, an empty dir, and the overlap guard in both directions.                                                                                                                                                      |
| `test/infrastructure/local-marketplace.test.ts` | A second plugin's entry survives the first one's uninstall; a hand-edited row is carried through; the last uninstall removes the directory.                                                                                         |
| `test/infrastructure/source-fetcher.test.ts`    | Root checkout on both arms, beside the existing subdirectory cases.                                                                                                                                                                 |
| `test/install-path.test.ts`                     | The whole flow over the existing `machine()` sandbox: a local dir and a stub-fetched GitHub repo into Cursor and VS Code, and the Claude path through `withClaude`, asserting the exact argv sequence rather than that it exited 0. |
| `test/actions/update.test.ts`                   | A local row whose directory is gone is `unavailable`, and the run exits 0.                                                                                                                                                          |
| `test/commands/install.test.ts`                 | `source_kind` on the events, and no `plugin` value for a local source.                                                                                                                                                              |

## Phases

Commit types are release decisions here, so the groundwork is deliberately separated from
the feature.

| #   | Phase                                      | Commit      | What it leaves                                                                                                                                                                                                                      |
| --- | ------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Route today's flow through the new types   | `refactor:` | The three `types/` modules, `MarketplaceOrigin` on `HarnessContext`, `needsSource` as a method. The marketplace kind is the only one that exists yet, and every existing test passes unchanged - which is the acceptance criterion. |
| 2   | Install from a local directory             | `feat:`     | The parser's local arm, `local-plugin.ts`, `local-marketplace.ts`, the Claude directory arm, the trust prompt, the manifest key, `installed` rendering, `source_kind`.                                                              |
| 3   | Install from a GitHub repo or subdirectory | `feat:`     | The parser's github arm, `readPluginManifest`, the root checkout in both fetch arms, the marketplace-not-a-plugin hint.                                                                                                             |
| 4   | Re-sync path plugins on update             | `feat:`     | The `restore` branch per row and the `unavailable` arm. Held back so phases 2 and 3 ship without `update` having to know about either yet.                                                                                          |
| 5   | Document the new sources                   | `docs:`     | README examples and the `--help` block. Contributor and agent knowledge goes to `CLAUDE.md` as each phase lands, not here.                                                                                                          |

## Open items

Each of these is worth settling before phase 2 writes it down. None of them changes the
shape above.

- **Does `marketplace update` exit 0 for a directory marketplace?** Its help reads "update
  marketplace(s) from their source", and a directory marketplace's `installLocation` _is_
  its source path - so it may be a no-op, and a no-op may or may not exit 0. Low risk:
  `refresh()` already treats a non-zero exit as a soft event rather than a failure, so the
  worst case is one warning line.
- **Does Claude read a directory marketplace in place, or copy it?** `installLocation`
  equal to the path itself says the _marketplace_ is read in place, while `installPath`
  under `plugins/cache/.../<version>` says the _plugin_ is copied. If the marketplace is
  genuinely read in place, staging a plugin needs no `marketplace update` at all - only
  the uninstall/install pair. Confirming this simplifies the harness rather than changing
  the design.
- **Should a bare `owner/repo` that turns out to be a marketplace offer to list it?** The
  plan fails with a hint naming `--repo` and `list`. Running the listing right there would
  be friendlier, and the machinery is one `ListAction` away - but it makes one command do
  two things, and the hint is already actionable. Deferred, not rejected.

## Out of scope

- **`--link` for a live development loop.** Copy-only was the call, so a local install is
  a snapshot and `update` is how you re-sync. A symlinking mode is the obvious follow-up
  for plugin authors; the guard it needs is that uninstall must never `rmrf` through a
  link, which is a real hazard and the reason it is not being bolted on here.
- **Local marketplace directories.** `--repo ./my-marketplace` is a separate axis from
  this feature. Worth noting that phase 1's `MarketplaceOrigin` is most of what it would
  need - a `directory` origin whose registry is read from disk rather than generated by
  us.
- **The other plugin source types Claude's schema allows** (`npm`, `archive`, `command`,
  `git-subdir` as a registry entry). This is about what a _user_ types, not about what a
  marketplace may declare; `sourcePathFor` already refuses an entry it cannot follow and
  says why.
