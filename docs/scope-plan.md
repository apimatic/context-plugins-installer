# context-plugins Scope Plan

Letting `install` put a plugin into Claude Code for one project rather than for every
project: a spike, then seven phases that each leave the suite green.

The goal is isolation, not distribution. This tool's built-in marketplace ships **SDK
plugins**, and an SDK plugin is useful in exactly the projects that use that SDK - in every
other project it is context spent on nothing. Claude Code loads every enabled plugin into
every session (skill descriptions, commands, agents, MCP tool schemas), shows a per-plugin
_Context cost_ in `/plugin`, and flags plugins _Not used recently_ because user-scoped
installs pile up. For the plugins this tool distributes, per-project is the natural scope
and machine-wide is the odd default. Claude offers the scope; this tool should be able to
ask for it.

| Date       | Base             | Claude Code tested | Cursor       | VS Code                               |
| ---------- | ---------------- | ------------------ | ------------ | ------------------------------------- |
| 2026-09-16 | `main @ 701767b` | 2.1.27x            | 2.6 (no CLI) | `chat.pluginLocations` MACHINE-scoped |

Revised 2026-09-16 after two adversarial reviews; the changes are listed in
[What the reviews changed](#what-the-reviews-changed).

Contents

1. [Decisions already made](#decisions-already-made)
2. [Is it worth doing](#is-it-worth-doing)
3. [What each editor supports](#what-each-editor-supports)
4. [What the user types](#what-the-user-types)
5. [The model](#the-model)
6. [The scoped record](#the-scoped-record)
7. [Install](#install)
8. [Uninstall](#uninstall)
9. [Update, installed, doctor](#update-installed-doctor)
10. [Configuration and telemetry](#configuration-and-telemetry)
11. [File map](#file-map)
12. [Phases](#phases)
13. [Tests](#tests)
14. [Risks and how each is held](#risks-and-how-each-is-held)
15. [Out of scope](#out-of-scope)
16. [What the reviews changed](#what-the-reviews-changed)

## Decisions already made

Settled in the conversation of 2026-09-16, then revised by two reviews the same day.
Everything below assumes them; change one and the affected phase changes with it.

| Decision             | Choice                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scopes accepted      | `user` (default) and `local`                                                     | `local` is the isolation scope: this repo, this user, kept out of git. `project` was in the first draft and is cut: it writes a **committed** file on the user's behalf, needs its own source rule and its own prose, and serves distribution, which is not the goal. It is one enum word away when someone asks.                                                                                                                                                                                  |
| Editors              | Claude Code only; Cursor and VS Code declare `['user']`                          | Cursor records project plugins in an undocumented `.cursor/settings.json` and has no install CLI (staff-confirmed, July 2026). VS Code's `chat.pluginLocations` is `ConfigurationScope.MACHINE`; the PR moving it to WINDOW (microsoft/vscode#315123) is open. Revisit each when that changes.                                                                                                                                                                                                     |
| What is true         | **Claude's own listing from the cwd**; our row is a hint                         | Claude places `.claude/settings.local.json` at the **git root** when launched in a subdirectory - except outside a repo, when the root is `~`, **on Windows**, or on an ownership mismatch, where it stays at cwd. No path we record can be the key to that. So `uninstall` asks Claude and reconciles the plugin's rows against its answer, and `update` reports against it without deleting.                                                                                                     |
| Reconciliation       | Only right after this run's own uninstall, and only for that plugin              | A listing alone must never clear a row: a different `CLAUDE_CONFIG_DIR` (which is how CI runs) or a directory Claude has not been asked to trust would empty the file in one `update`. So `update` reports a row Claude does not list and leaves it; `uninstall` clears the rows of the plugin it just acted on, when Claude confirms each is gone.                                                                                                                                                |
| The project          | The current directory, as run, `path.resolve`d                                   | It is where `claude` would be launched and where its `plugin list --json` is asked. The row records it for `installed` and `update`; nothing treats it as the location of Claude's file.                                                                                                                                                                                                                                                                                                           |
| Already machine-wide | `install --scope local` warns when the plugin is at `user` scope                 | Every existing user has the SDK plugin machine-wide. Adding a `local` registration beside it isolates nothing, so the run says so and prints the `uninstall` that would. A warning, not a failure: the user may be mid-migration.                                                                                                                                                                                                                                                                  |
| Targets omitted      | Narrow to the editors that support the scope, and say so                         | One line names the editors left out and why. An editor named **explicitly** in `--targets` that cannot do the scope is a `Failure`, not a skip: it is here and cannot, which is the user's to know.                                                                                                                                                                                                                                                                                                |
| Sources at `local`   | Every kind - marketplace, folder, repository                                     | The generated directory marketplace is per-user, and so is the local settings file. Claude's native answer for a folder plugin in one project is the skills directory (below); this tool's is a marketplace it generates, which keeps monitors, MCP and the user's repository out of the picture.                                                                                                                                                                                                  |
| Source clash         | Checked across **both** records for every directory origin                       | Staging is keyed by plugin id alone. Two folders whose manifests share a name would overwrite one another's staged copy and one project would load the other's code. The existing `conflictFor` rule, widened to the scoped file, refuses it; `--force` is the escape as today.                                                                                                                                                                                                                    |
| Where rows live      | A separate file, `~/.context-plugins/scoped.json`                                | `manifest-store.ts`'s `write` emits `{version, plugins}` only, so an older build's next `upsert` would drop any other key from `installed.json`, and an extra field on a `plugins` row would be folded into the user row and removed with it. A file no shipped build opens is the only shape an old build can neither misread nor lose.                                                                                                                                                           |
| Uninstall lookup     | **cwd**, asking Claude; `--force` may clear rows whose directory is gone         | Acting on a row for another directory because it happened to be the only one is a wrong-target hazard for any script. From cwd the run proceeds when Claude lists the plugin there **or** a row names cwd - the row is a hint, so it cannot be the gate - and afterwards reconciles this plugin's other rows against Claude. The one exception to cwd-only is a directory that no longer exists: there is no cwd to run from, so `--force` clears its row as a record-only edit, spawning nothing. |
| `installed --json`   | One array; each entry carries `scope` and `project`                              | An object with two arrays would break every reader that expects the array it gets today. `scope` defaults to `"user"` on the rows it always had.                                                                                                                                                                                                                                                                                                                                                   |
| rc default           | `"scope"` allowed in the **cwd** rc only, for every command that takes `--scope` | A repo's `.contextpluginsrc` saying `"scope": "local"` makes every `install` **and** `uninstall` in that repo local without the flag - one without the other would have `uninstall my-sdk` look machine-wide and answer "it is installed for: this directory". The home rc setting it is a `Failure` naming the file: a global default of `local` would surprise every other directory.                                                                                                            |
| Before any code      | A spike against a real `claude`, on Linux and Windows                            | Four behaviours the design rests on are documented but untested by this project, and each changes the design if wrong. See [Phase 0](#phases).                                                                                                                                                                                                                                                                                                                                                     |
| Plan location        | This file                                                                        | Beside `docs/layering-plan.md`, where `CLAUDE.md` already sends contributors.                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Is it worth doing

Yes, in this size, and the case should be made honestly because Claude already has three
native answers to "this plugin, this project only":

- **A marketplace plugin**: `claude plugin install my-sdk@context-plugins --scope local`,
  after a one-time `claude plugin marketplace add apimatic/context-plugins`. One line.
- **A folder plugin**: copy it to `.claude/skills/<name>/` and it loads as
  `<name>@skills-dir` with no marketplace and no install step. It sits in the user's
  repository (committed unless they gitignore it), monitors do not load, and MCP servers
  need per-server approval.
- **A plugin under development**: `claude --plugin-dir ./my-plugin`, per launch.

What this tool adds on top of those, and the whole of the benefit:

1. **Our users already type `npx context-plugins install my-sdk`.** The flag meets them
   there; without it, isolation means learning a second tool's flags and marketplace name.
2. **An inventory across projects.** `installed` answers "which of my projects have which
   SDK plugin", which nothing in Claude does - `claude plugin list` is one cwd at a time.
3. **`update` across projects.** Claude's auto-update is off by default for third-party
   marketplaces, and it cannot update a folder plugin at all; `update` refreshes every
   scoped copy from wherever it is run.
4. **The marketplace stays out of the repository.** The skills-directory route puts plugin
   files in the user's checkout; ours leaves the checkout untouched.
5. **A signal.** The `scope` telemetry property says whether anyone uses it. If a quarter
   of installs are `local` after a release or two, the default is worth revisiting; if
   nobody does, the flag is cheap to keep and the question is answered.

That is a real but modest benefit. It justifies the size below - one scope, one editor,
one record file - and not the first draft's.

## What each editor supports

**Claude Code.** `claude plugin install <id>@<mkt> --scope user|project|local` (default
`user`); `uninstall`, `enable` and `disable` take the same flag.

| Scope     | File                          | Shared with                           |
| --------- | ----------------------------- | ------------------------------------- |
| `user`    | `~/.claude/settings.json`     | every project on this machine         |
| `project` | `.claude/settings.json`       | every collaborator, via git           |
| `local`   | `.claude/settings.local.json` | this repo, this user; kept out of git |

- **Where the local file goes.** `.claude/settings.json` is read from the session's primary
  working directory, with no walk-up. `.claude/settings.local.json` is different: started
  in a subdirectory of a git repository, Claude reads and writes it **at the repository
  root** (in a worktree, at the main checkout's root) - _except_ outside a git repository,
  when the root is the home directory, **on Windows**, or when the root, `.git` or `.claude`
  is not owned by the user, where it stays beside `.claude/settings.json` at cwd. This is
  the fact that makes a recorded path a hint rather than a key.
- **Git.** The first time Claude Code writes `.claude/settings.local.json` in a repository
  that does not already ignore it, it adds `**/.claude/settings.local.json` to the user's
  **global** git excludes. Whether the non-interactive `claude plugin install --scope local`
  path does the same is not documented; Phase 0 checks.
- Marketplace registration is per-user (`~/.claude/plugins/known_marketplaces.json`)
  whatever the scope, which is why a `directory` marketplace works at `local`.
- `claude plugin list --json` reports one row per scope with `id`, `scope` (`user`,
  `project`, `local`, `managed`, `synced`), `version`, `path`, `enabled`. The `local` rows
  are those Claude would load from the cwd it runs in. Phase 0 confirms that from a
  subdirectory as well as a root.
- The plugin cache (`~/.claude/plugins/cache/<mkt>/<id>/<ver>`) is shared across scopes.

**Cursor.** `/add-plugin` offers user or project scope in the UI; project plugins are
recorded in the repo's `.cursor/settings.json`, whose shape is undocumented. There is no
`plugin install` CLI. Local plugins live in `~/.cursor/plugins/local/<name>`, which is
where this tool copies.

**VS Code.** Plugins load from paths in `chat.pluginLocations`, a MACHINE-scoped setting,
so a `.vscode/settings.json` entry is rejected (microsoft/vscode#303853, closed as a
duplicate of PR #315123, which is open).

## What the user types

```
npx context-plugins install my-sdk --scope local
npx context-plugins install ./my-plugin --scope local
npx context-plugins install acme/my-plugin --scope local --targets claude
npx context-plugins uninstall my-sdk --scope local
npx context-plugins installed
```

- `--scope` is a value flag in `commands/args.ts`, validated by `asScope`; a word it does
  not know is exit 2 like any unreadable command line. Omitted, it is `user`, and every
  existing command line means exactly what it did.
- `install ... --scope local` with no `--targets` installs into Claude Code and prints one
  line: `Cursor and VS Code cannot install for one project; left out.` With
  `--targets claude,cursor` it fails before touching anything, naming Cursor and why.
- `install ./other/my-plugin --scope local` when a folder also called `my-plugin` is
  already staged from somewhere else - for this project, another, or the whole machine -
  fails with today's clash message: `'my-plugin' is already installed from a different
source.` `--force` replaces it, as today.
- `install my-sdk --scope local` when `my-sdk` is already installed machine-wide succeeds
  and warns: `'my-sdk' is also installed for the whole machine, so Claude Code still loads
it everywhere. Run `npx context-plugins uninstall my-sdk` to keep only this project's.`
- `uninstall my-sdk --scope local` from the directory it was installed in - or from any
  directory where Claude lists it for this project, such as the repository root after an
  install from a subfolder - removes it there. From anywhere else it fails:
  `'my-sdk' is not installed for this directory. It is installed for: ~/work/a, ~/work/b.` -
  the paths are a hint, and nothing is done to them. With `--force`, rows whose directory
  no longer exists are cleared from the record from wherever the command runs:
  `~/work/old is gone; cleared its record for 'my-sdk'.`
- `uninstall my-sdk` with no flag is today's user-scope uninstall, untouched. If the plugin
  is _only_ installed for projects, the not-installed message names them.
- `installed` lists the machine-wide rows as today, then `In projects` with one line per
  scoped row: plugin, shortened project path. `--json` is still one array; every entry
  carries `scope` (`"user"` on the rows it always had) and `project` (absent on those).

## The model

Everything new in `types/` first, because the rules should sit on the values that carry
them. Skills: `value-object`, `context`, `event`.

- **`types/scope.ts`** - `Scope = 'user' | 'local'`, `SCOPES` in that order,
  `asScope(value: unknown): Scope | null` for every boundary (flag, rc file, scoped.json),
  and `isolated(scope)` = `scope !== 'user'`. `CLAUDE_SCOPES` is the set of words Claude's
  listing is known to use - `user`, `project`, `local`, `managed`, `synced` - and exists
  for one rule: a word **not** in it counts as possibly ours (the absence check, below).
  Two of those words are new to this build; today `managed` and `synced` rows read as ours
  at user scope, which the generalisation quietly fixes.
- **`DirectoryPath.same(other)`** in `types/file/paths.ts` - equality under the path's own
  `PathRules`: normalised separators, no trailing separator, case-folded on `win32`. The
  scoped key needs it, and it is the one place path equality may be written, the way
  `RepoSlug.same` is for slugs. A symlinked cwd and its target are two paths and two
  rows; `uninstall`'s reconciliation (below) is what collapses them.
- **`Harness.scopes: readonly Scope[]`** in `types/harness.ts`. Claude declares both;
  Cursor and VS Code declare `['user']`. Same shape as `needsSource`: a fact about an
  editor, declared once, read by a pure decision. `HarnessContext` gains `scope: Scope`,
  `project: DirectoryPath | null` (`null` exactly when `scope` is `user`) and
  `stagingShared: boolean` (see [Uninstall](#uninstall)). The `plugin-installed` and
  `plugin-absent` events already carry `scope`; the rendered lines say it when it is not
  `user`.
- **`application/scope-selection.ts`** (pure) - `selectForScope({ requested, explicit,
scope, capabilities })` answers `{ want, leftOut: { name, reason }[] } | Failure`. The
  reasons are per-editor prose in a `Record<HarnessName, string>`, so an editor added
  without one does not compile. **`application/scope-resolution.ts`** (pure) - the flag,
  the cwd rc and the home rc into one `Scope` or a `Failure`, with the home-rc refusal.
  **`application/staging-decision.ts`** (pure) - `stagingShared` over both read views.

## The scoped record

A second file, `~/.context-plugins/scoped.json`, with its own three layers mirroring
`installed.json`'s: bytes in `infrastructure/manifest-store.ts` (the existing `read` /
`write` helpers over a second path from `paths.scopedManifestPath`), the row rules in
`types/scoped-record.ts`, and the file as a domain object in `types/scoped-records.ts`
over a `ScopedStore` port. Skill: `context`.

```json
{
  "version": 1,
  "plugins": [
    {
      "plugin": "my-sdk",
      "repo": "apimatic/context-plugins",
      "marketplace": "context-plugins",
      "ref": "main",
      "scope": "local",
      "project": "C:\\repos\\billing",
      "targets": ["claude"],
      "installedAt": "2026-09-16T10:00:00.000Z"
    }
  ]
}
```

- **What a row is.** A record that this tool, run in `project`, installed `plugin` from
  `repo` at `scope`. It is what `installed` lists and what `update` refreshes. It is **not**
  the location of Claude's settings file and **not** proof the registration still exists -
  Claude's listing from that directory is both, and `update` asks it.
- **Key** is plugin + repo (`RepoSlug.same`) + project (`DirectoryPath.same`) + scope.
  There is no `foldRows`: the key already includes the path, and a scoped row can never
  fold with a user row because the user row is in another file. `upsert` and `remove` act
  on every row the key matches all the same, since two spellings of a repo are still one
  repository.
- **Row rules** are `installed-record.ts`'s, reused rather than copied: `sanitizeEntry`,
  `rowShape`, `foreignTargets` all operate on `targets` and apply unchanged. Added:
  validation of `scope` through `asScope` and `project` through `nonEmptyString`; a row
  failing either is dropped from the read view with a reason and **never from disk** - the
  manifest's rule, kept. `read()` reports `ignored` and `elided` the same way, and
  `gapWarnings` in `prompts/gaps.ts` renders them the same way.
- **Two rows, one registration.** On Linux and macOS, installing from `repo/` and again
  from `repo/packages/api` records two rows while Claude holds one registration at
  `repo/.claude/settings.local.json`. That is allowed. `uninstall` from `repo/` removes the
  registration and clears the first row, then asks Claude from `repo/packages/api`, is told
  the plugin is not listed there, and clears the second - a finding made right after the
  run's own action, for the plugin it acted on. Nothing has to know Claude's placement
  rule. `update`, by contrast, only **reports** a row Claude does not list: see
  [Reconciliation](#decisions-already-made) for why a listing alone never deletes.
- **Why not `installed.json`.** Every shipped build reads that file, and an older build's
  `write` emits `{version, plugins}` and nothing else: a `scoped` array would survive a
  read and vanish on the next `upsert`, and a `project` field on a `plugins` row would be
  ignored, folding a user row and a local row into one key that an old `uninstall` removes
  together. A file the old build never opens has neither failure mode. The one thing this
  phase does to `installed.json` is a side fix: `write` carries unknown **top-level** keys
  through, so a future field does not repeat this.
- **`ManifestContext` is not widened.** `ScopedRecords` is its sibling. An action that
  needs both takes both: "what is on this machine" and "what is in which project" stay two
  questions. `conflictFor` becomes a pure function over **both** read views
  (`application/source-clash.ts`), because the clash it guards - one staging directory per
  plugin id - is shared by every row in either file.

## Install

Skills: `command`, `action`, `prompts`, `event`.

1. `commands/args.ts` gains `scope`; `commands/router.ts` resolves it after the brand (it
   needs the cwd rc) and before dispatch, and hands `scope` and `cwd` to the command.
2. `actions/install.ts` runs `selectForScope` **before** `resolveTargets` narrows or asks:
   an explicit unsupported target is the `Failure`; an implicit one is a
   `prompts.leftOut(...)` line and a shorter `want`. With `want` empty after narrowing the
   run fails: "no editor here can install for one project". Narrowed to Claude Code and
   then not detecting it is today's not-installed skip, exit 0 - the scope changed nothing
   about whether the editor is here.
3. The **source clash** check runs for every directory-origin install at any scope, over
   both records, before the fetch: a plugin of this name staged from a different source
   key - for this project, another, or the machine - is the existing `Failure`, and
   `--force` replaces it as today. A marketplace source at `local` is checked the way a
   user-scope one is now.
4. Staging is unchanged: `stageLocalPlugin` under `~/.context-plugins/marketplace` for a
   folder or repository source, when Claude Code is a target. Two projects installing the
   same folder plugin share one staged copy, refreshed by whichever installs later.
5. `HarnessContext` carries `scope` and `project = DirectoryPath(cwd)`; the Claude harness
   spawns `claude` with `{ cwd: project }` for `plugin install`, `plugin uninstall` and
   `plugin list`, through a `cwd` argument on `ClaudeCli`'s methods -
   `infrastructure/process-runner.ts`'s `run` already forwards `SpawnOptions`, so this is
   plumbing. The pre-install `pluginUninstall` for a `directory` origin uses the scope
   being installed, not `user`.
6. Recording: `scope === 'user'` writes `ManifestContext.recordInstall` as today;
   otherwise `ScopedRecords.recordInstall` with `scope` and `project`.
7. **The machine-wide warning.** At `local`, when `installed.json` holds a row for this
   plugin with `claude` among its targets, the run warns after the install that Claude
   Code still loads the plugin everywhere and prints the `uninstall` that would isolate
   it. This is the migration path for every existing user of the tool, so it is a line,
   not a footnote. It reads our record only: asking Claude's user-scope listing too would
   cost a spawn to confirm what the record already says, and a registration the user made
   by hand is theirs to know about.
8. Prompts: the success line says `for this project` and, once Phase 0 has confirmed
   whether Claude excludes the file from git on this path, either nothing or one line
   telling the user to ignore `.claude/settings.local.json`. The `--json` install payload
   gains `scope` and `project`.

## Uninstall

Skills: `action`, `prompts`.

1. `--scope user` (or none): today's path, byte for byte. If the user manifest has no row
   but `scoped.json` has one or more for the plugin, the not-installed hint names them.
2. `--scope local`: the run proceeds when **either** a row names cwd (`DirectoryPath.same`)
   **or** Claude lists the plugin at a scope that counts as ours from cwd - the second is
   what lets an install made from a subfolder be removed from the repository root where
   Claude actually put it. Neither is a `Failure` listing the projects that do have a row
   (paths shortened by `prompts/format.ts`, never in telemetry), and **nothing is done to
   them**. The listing is asked once here and reused by step 3's absence check.
3. The harness runs `claude plugin uninstall <id>@<known> --scope local` with
   `cwd = project`. The absence check generalises from `!OTHER_SCOPES.has(scope)` to
   `ours(scope, asked) = !CLAUDE_SCOPES.has(scope) || scope === asked` - a row whose
   scope word this build does not know still counts as possibly ours, which is the
   invariant `CLAUDE.md` names: an unrecognised anything from Claude is unanswered, never
   proof of absence. Rows for other known scopes are not ours.
4. `decideUninstall` runs unchanged over the cwd row (or `null` when only Claude knew) and
   the single outcome, and `ScopedRecords.applyUninstall` writes what it says.
   `uninstallLines` renders the same summary; one added line says `for this project`.
5. **Reconciliation, here and only here.** When the outcome is `removed` or `absent`, the
   action asks Claude from the `project` of every **other** scoped row for this plugin
   (skipping directories that no longer exist) and clears each one Claude no longer lists,
   with the line `no longer installed for <project>; record cleared`. This is bounded to
   the plugin the run just acted on and follows the run's own action, which is when a
   "not listed" answer is most trustworthy; it is what settles two rows for one
   registration. A `null` listing settles nothing and the row stays.
6. **`--force` and a directory that is gone.** With `--force`, rows for this plugin whose
   `project` directory does not exist are cleared as a record-only edit - nothing is
   spawned, because there is nothing to spawn into - and each is reported: `<project> is
gone; cleared its record for '<plugin>'`. This is the one way such a row leaves the
   file, and it works from any directory, because there is no directory to run it from.
   Rows whose directory exists are never touched from elsewhere.
7. **The staging guard.** Today the harness unstages a `directory`-origin plugin from the
   generated marketplace - and removes the marketplace when it was the last plugin - as
   soon as Claude reports it `removed` or `absent`. With scopes one staged copy can back
   several registrations (`local` in two projects, or `user` and `local`), so the harness
   must not take it away on the first one out. The harness cannot see records, so the
   action tells it: `HarnessContext.stagingShared` is `true` when any **other** row in
   either file names this plugin from the same source key, computed by the action before
   the loop. The harness's `unstage` is skipped when it is `true`. The rule is
   `application/staging-decision.ts`, one pure function, so the test can enumerate it. A
   stale row (a registration Claude no longer holds) keeps the staged copy and the
   marketplace registration alive until an `uninstall` of that plugin reconciles it or
   `--force` clears it. That is a leak of one folder and one `claude plugin marketplace
list` row, stated here rather than fixed by a listing-driven delete in `update`, which
   [Reconciliation](#decisions-already-made) refuses.

## Update, installed, doctor

Skill: `action`.

- **`update`** iterates `installed.json` as today, then `scoped.json`. For each scoped row
  it first asks Claude from the row's `project`: `claude plugin list --json` there, **once
  per directory** - the session memoises `listPlugins(cwd)` by `DirectoryPath.same`, so ten
  projects with two SDK plugins each cost ten listings, not twenty; without that memo this
  command's habitual run would grow by a `claude` start-up per row. A listing that does not
  name the plugin at a scope that counts as ours makes the row `skipped` with the line
  `Claude Code no longer lists it for <project>; run `npx context-plugins uninstall
  <plugin> --scope local` there to clear the record`. It is **not** cleared: a listing alone
  is not a positive finding - a different `CLAUDE_CONFIG_DIR`, or a directory Claude has
  not been asked to trust, answers "nothing" for every row - and re-installing instead
  would re-register a plugin the user removed by hand with `claude` itself. A listing this
  build cannot read (`null`) settles nothing and the row is refreshed as usual. A row whose
  `project` directory no longer exists is `unavailable` with the reason "project directory
  is gone; `npx context-plugins uninstall <plugin> --scope local --force` clears the
  record", never spawned into. Otherwise the row hands `InstallAction` the same rebuilt
  `PluginSource` (`sourceFor` unchanged) plus `scope` and `project`; the session is shared,
  so three projects on one marketplace still read the registry once.
- **`installed`** renders `In projects` and the single-array `--json` payload.
  `InstalledReport.scoped: boolean` - which today means "narrowed by `--targets`" - is
  renamed `narrowed` first, so the word `scoped` means one thing in the codebase.
- **`doctor`** adds one check: scoped rows whose project directory is missing, counted the
  way gaps are, on stderr under `--json`, naming the `--force` command that clears them.
- **`list`** is unchanged: it is about a marketplace, not about installs.

## Configuration and telemetry

- `RcFile` gains `scope?: string`, read by `rc-file.ts` like the other string fields and
  validated by `asScope` at the boundary (a bad word is a `Failure` naming the file).
  `scope-resolution.ts` applies flag → cwd rc → `user`; a home rc that sets it is a
  `Failure` naming that file. The router resolves it once and hands the same value to
  every command that takes `--scope` - `install` and `uninstall` today - so an rc that
  makes installs local makes uninstalls local too. `CLAUDE.md`'s configuration section
  states the exception.
- Telemetry: `scope` (`user` | `local`) on `PluginInstalled`, `PluginInstallFailed`,
  `PluginUninstalled`, `PluginUninstallFailed`, declared in each class's `properties()`.
  `COLLECTED` in `types/telemetry.ts` gains "whether the plugin was installed for the
  whole machine or for one project (never the project's path)". `telemetry status` and the
  notice print it from there. The project path never leaves the machine: it is not on any
  event, and the "in projects" listing is prose. This property is also the feature's
  success signal - see [Is it worth doing](#is-it-worth-doing).

## File map

New:

| File                                                                                                                                                                                                                                                                                                                                                              | Layer          | Holds                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `src/types/scope.ts`                                                                                                                                                                                                                                                                                                                                              | `types/`       | `Scope`, `asScope`, `isolated`, `CLAUDE_SCOPES`                                                         |
| `src/types/scoped-record.ts`                                                                                                                                                                                                                                                                                                                                      | `types/`       | row validation, key comparison (`sameScopedEntry`)                                                      |
| `src/types/scoped-records.ts`                                                                                                                                                                                                                                                                                                                                     | `types/`       | `ScopedRecords` over `ScopedStore`: read view, `locate`, `rowsFor(plugin)`, the two writes, `clearGone` |
| `src/application/scope-selection.ts`                                                                                                                                                                                                                                                                                                                              | `application/` | `selectForScope`, the per-editor reasons                                                                |
| `src/application/scope-resolution.ts`                                                                                                                                                                                                                                                                                                                             | `application/` | flag / cwd rc / home rc into one `Scope`                                                                |
| `src/application/staging-decision.ts`                                                                                                                                                                                                                                                                                                                             | `application/` | `stagingShared` over both read views                                                                    |
| `src/application/source-clash.ts`                                                                                                                                                                                                                                                                                                                                 | `application/` | `conflictFor` over both read views                                                                      |
| `test/types/scope.test.ts`, `test/types/scoped-records.test.ts`, `test/application/scope-selection.test.ts`, `test/application/scope-resolution.test.ts`, `test/application/staging-decision.test.ts`, `test/application/source-clash.test.ts`, `test/actions/install-scope.test.ts`, `test/actions/uninstall-scope.test.ts`, `test/actions/update-scope.test.ts` | tests          | see [Tests](#tests)                                                                                     |

Changed:

| File                                                                                                  | Change                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/types/file/paths.ts`                                                                             | `DirectoryPath.same`                                                                                      |
| `src/types/harness.ts`                                                                                | `Harness.scopes`; `HarnessContext.scope`, `.project`, `.stagingShared`                                    |
| `src/types/ports.ts`                                                                                  | `ScopedStore`; `ClaudeCli` methods take `cwd`                                                             |
| `src/types/brand.ts`                                                                                  | `RcFile.scope`                                                                                            |
| `src/types/manifest-context.ts`                                                                       | `conflictFor` moves out to `application/source-clash.ts`                                                  |
| `src/types/reports.ts`                                                                                | `InstalledReport.scoped` → `narrowed`; entries carry `scope` / `project`; install/uninstall carry `scope` |
| `src/types/events/plugin-*.ts`                                                                        | `scope` property                                                                                          |
| `src/types/telemetry.ts`                                                                              | `COLLECTED`                                                                                               |
| `src/infrastructure/manifest-store.ts`                                                                | second store; `write` carries unknown top-level keys                                                      |
| `src/infrastructure/paths.ts`                                                                         | `scopedManifestPath`                                                                                      |
| `src/infrastructure/claude-cli.ts`                                                                    | `cwd` on install / uninstall / list                                                                       |
| `src/infrastructure/session.ts`                                                                       | memo for `listPlugins(cwd)`, keyed by `DirectoryPath.same`                                                |
| `src/infrastructure/rc-file.ts`                                                                       | reads `scope`                                                                                             |
| `src/harnesses/claude.ts`                                                                             | `scopes`; reads `ctx.scope` / `ctx.project`; generalised `ours`; `unstage` gated                          |
| `src/harnesses/cursor.ts`, `vscode.ts`                                                                | `scopes = ['user']`                                                                                       |
| `src/actions/install.ts`                                                                              | selection, clash over both records, recording, `stagingShared`                                            |
| `src/actions/uninstall.ts`                                                                            | cwd row or Claude's listing, hint, reconciliation, `--force` for gone directories, `stagingShared`        |
| `src/actions/update.ts`                                                                               | second loop, `skipped` for a row Claude does not list, `unavailable` for a gone project                   |
| `src/actions/installed.ts`, `doctor.ts`                                                               | section; check                                                                                            |
| `src/commands/args.ts`, `router.ts`, `install.ts`, `uninstall.ts`                                     | flag, resolution, events                                                                                  |
| `src/prompts/install.ts`, `uninstall.ts`, `update.ts`, `installed.ts`, `harness/claude.ts`, `help.ts` | the lines above                                                                                           |
| `src/composition/index.ts`                                                                            | builds the second store and `ScopedRecords`                                                               |
| `.claude/skills/add-harness/SKILL.md`                                                                 | `scopes` on the checklist                                                                                 |
| `.github/workflows/ci.yml`                                                                            | the `claude` job's new arm                                                                                |
| `README.md`, `CLAUDE.md`                                                                              | `--scope`; a Scopes section                                                                               |

## Phases

Phase 0 writes no code and gates the rest. Phases 1-7 each land green - `npm test`,
`npm run typecheck`, `npm run lint` - and each is a run of self-contained commits. The
first three change nothing a user can see; the last four each ship one command's worth.
Commit type is `feat(...)` for the phases that change behaviour and `refactor:` for the
ones that do not, because commit types are release decisions here.

0. **Spike.** Half a day with a real `claude`, on Linux and on Windows, from a repo root
   and from a subdirectory of it, with `CLAUDE_CONFIG_DIR` sandboxed as the CI job does.
   Record the answers at the top of this document, then decide:
   - Does `claude plugin install x@m --scope local` from a subdirectory write
     `.claude/settings.local.json` at the root on Linux and at cwd on Windows, as the docs
     say? (Confirms the "hint, not key" decision; if it is cwd everywhere, the record could
     be a key after all and the reconciliation in `update` becomes a safety net rather than
     the mechanism.)
   - Does `claude plugin list --json` from the subdirectory list the plugin with
     `"scope": "local"`, and from an unrelated directory not list it? (The absence check
     and the reconciliation both rest on this. If it is not cwd-relative, Phase 5's
     absence check reads `.claude/settings.local.json` directly - a new boundary reader -
     and nothing else changes.)
   - Does `claude plugin list --json` include `local` rows from a directory Claude has
     **never been asked to trust** - a fresh clone, a CI checkout - and does
     `plugin install --scope local` succeed there? (Project-scope plugins load only after
     the trust dialog; if the listing is gated the same way, "not listed" is not evidence
     and even `uninstall`'s reconciliation has to be narrowed to directories Claude has
     seen.)
   - Does the non-interactive install add `**/.claude/settings.local.json` to the global git
     excludes, so that `git status` stays clean? (Decides whether Phase 4 prints the
     "ignore this file" line.)
   - Does a `directory` marketplace under `CP_STATE_DIR` install at `--scope local` and
     survive `plugin marketplace update`? (The whole folder-source arm.)
1. **Model.** `types/scope.ts`, `DirectoryPath.same`, `Harness.scopes` (Claude declares
   both, the others one), `HarnessContext.scope` / `project` / `stagingShared` with
   defaults `'user'` / `null` / `false`, `application/scope-selection.ts`,
   `scope-resolution.ts`, `staging-decision.ts`, `source-clash.ts` (moving `conflictFor`
   out of `ManifestContext` with its behaviour intact) - all with their tests. Nothing
   reads the new ones yet. `refactor:`.
2. **Claude honours the context.** `ClaudeCli` methods take `cwd`; the harness reads
   `ctx.scope` and `ctx.project`, spawns with `cwd`, generalises `ours`, gates `unstage` on
   `stagingShared`; the session memoises `listPlugins(cwd)`. Every caller still passes
   `user` / `null` / `false`, so behaviour is unchanged; the fake-runner tests assert the
   argv now carries `--scope user` and no `cwd`. `refactor:` - with the `managed` /
   `synced` fix called out.
3. **The record exists.** `paths.scopedManifestPath`, the second store, `ScopedStore`,
   `types/scoped-record.ts`, `types/scoped-records.ts`, composition wiring, the side fix to
   `write`. Nothing writes a row yet. `refactor:`. Kept apart from phase 2 so that each is
   one reviewable idea: the harness learning where to stand, and the file that remembers.
4. **Install.** The flag, the rc field, resolution in the router, selection, the clash
   over both records, recording, the machine-wide warning, prompts, events, `COLLECTED`.
   `feat(install): install a plugin for one project with --scope local`. This is the
   release users notice.
5. **Uninstall.** The cwd row or Claude's listing, the hint, the summary line, the
   reconciliation of the plugin's other rows, `--force` for directories that are gone,
   `stagingShared` from both records, the hint when only scoped rows exist, the rc default
   reaching this command. `feat(uninstall)`.
6. **Update, installed, doctor.** The second loop, `skipped` for a row Claude does not
   list, `unavailable` for a gone project, `In projects`, the single-array payload, the
   rename to `narrowed`, the doctor check. `feat(update)`.
7. **CI and docs.** The `claude` job arm, `README.md`, `CLAUDE.md`, the `add-harness`
   skill. `ci:` / `docs:`.

## Tests

- `test/application/scope-selection.test.ts` walks every harness × every scope ×
  explicit-or-not and asserts: an explicit unsupported target is a `Failure` naming it; an
  implicit one is left out with a reason; `user` never narrows; the `Record` of reasons
  covers every `HarnessName`.
- `test/application/staging-decision.test.ts` enumerates the row combinations: no other
  row, a user row, a scoped row in the same project, a scoped row in another project, rows
  from a **different** source with the same id (not shared), `--force` (irrelevant, and
  asserted so).
- `test/application/source-clash.test.ts`: the existing `conflictFor` cases, plus a scoped
  row from another source clashing with a user install, a user row clashing with a scoped
  install, two scoped rows in different projects from different sources, and the same
  source in two projects (no clash).
- `test/types/scoped-records.test.ts` mirrors `manifest-context.test.ts`: key match through
  `RepoSlug.same` and `DirectoryPath.same` (a `win32` path in two cases is one row; a
  `posix` one is not), `locate` by cwd, an unknown `scope` word ignored from the view and
  kept on disk, foreign targets carried through a rewrite.
- `test/actions/install-scope.test.ts` drives the fixture with a fake `claude`: argv
  carries `--scope local` and the spawn carries `cwd`; the row lands in `scoped.json` and
  not `installed.json`; `--targets claude,cursor --scope local` fails before any file
  moves; `--scope local` with no targets installs into Claude, leaves the others out, and
  says so; Claude narrowed-to and undetected is a skip with exit 0; a same-named folder
  from another source is refused and `--force` replaces it; a user-scope row for the same
  plugin produces the machine-wide warning with the uninstall command, and its absence
  produces none.
- `test/actions/uninstall-scope.test.ts`: the cwd row; **no row but Claude lists it from
  cwd** proceeds and removes it; from elsewhere with neither, a `Failure` that lists the
  other projects and spawns nothing; absence via `list --json` rows with `scope: 'local'`
  counts as ours, `scope: 'user'` does not, `scope: 'weird'` counts as ours; after a
  removal, another row for the plugin whose directory Claude no longer lists is cleared
  with its line, one Claude still lists stays, one whose listing is `null` stays, one whose
  directory is gone is skipped; `--force` from an unrelated directory clears the gone
  directory's row and refuses the existing one's; the staged copy survives the first of
  two projects uninstalling and goes with the second; the marketplace goes with it; the
  cwd rc's `scope` makes a bare `uninstall` local.
- `test/actions/update-scope.test.ts`: a row Claude no longer lists is `skipped` with the
  uninstall hint and **stays on disk**; a `null` listing refreshes as usual; a gone
  directory is `unavailable` with no spawn and names the `--force` command; two rows in
  one directory cost one `plugin list` spawn.
- `test/install-fixture.ts`: `installPlugin` and `uninstallPlugin` take `scope` and `cwd`,
  checked with `satisfies` the way `HarnessOpts` is.
- The **`claude` CI job** grows one arm that only a real `claude` can run: from a temp
  project directory, `install "$src" --targets claude --scope local -y`; assert
  `claude plugin list --json` **from that directory** shows
  `smoke-plugin@context-plugins-local` with `"scope": "local"` and from `$RUNNER_TEMP` does
  not; repeat from a **subdirectory** of a second temp git repository, assert the same
  listing, **and assert where `.claude/settings.local.json` landed** (the root, on the
  Linux runner - a change in Claude's placement rule must fail here rather than
  reintroduce the misfiled-row scenario); `git status --porcelain` is empty there; install
  the same folder into a third project; uninstall from the first and assert the others are
  still listed and the marketplace still registered; `update` and assert nothing was
  cleared; uninstall from the second repository's **root** (where the row names the
  subdirectory) and assert Claude no longer lists it and the row is gone; uninstall the
  rest and assert all gone. This arm is the only thing that verifies the cwd-relative
  listing the whole design assumes, and it runs on the unpinned CLI on purpose. It runs on
  Linux only: the Windows placement rule is checked once, by hand, in Phase 0, and the plan
  says so rather than pretending otherwise.

## Risks and how each is held

| Risk                                                                   | Held by                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude plugin list --json` not being cwd-relative for `local` rows    | Phase 0 answers it before code; the `claude` CI arm asserts it from a root and a subdirectory on every run. If it fails, the absence check reads `.claude/settings.local.json` directly - one new boundary reader - and nothing else changes.                                                                                     |
| Claude placing the local file at the git root, or at cwd, by platform  | Nothing keys on the file's location. `uninstall` proceeds on Claude's listing from cwd as readily as on a row, then reconciles the plugin's other rows. Two rows for one registration is an allowed state that the next `uninstall` of that plugin collapses. The CI arm asserts the placement on Linux; Windows is Phase 0 only. |
| A listing that omits rows without being unreadable                     | A different `CLAUDE_CONFIG_DIR`, or a directory Claude has not been asked to trust, may answer "nothing" for every row. Nothing deletes on a listing alone: `update` reports and keeps; `uninstall` clears only the rows of the plugin it just removed itself. Phase 0 asks the trust question directly.                          |
| A row for a directory that no longer exists                            | `uninstall --force` clears it from anywhere as a record-only edit; `doctor` and `update` both print that command. Without this the row would be permanent, since cwd-only has no cwd to offer.                                                                                                                                    |
| A plugin at `user` and `local` at once                                 | Isolation has no effect until the user-scope copy goes. `install --scope local` says so and prints the uninstall; the tool never removes the user copy on its own.                                                                                                                                                                |
| Claude adding a scope word                                             | `CLAUDE_SCOPES` is a denylist for "not ours"; an unknown word is possibly ours, so the failure mode is "would not clear a row", never "cleared a row it should not have".                                                                                                                                                         |
| The same plugin name staged from two folders                           | `source-clash.ts` over both records refuses it; `--force` replaces, as today. Enumerated in its test.                                                                                                                                                                                                                             |
| The non-interactive install not excluding the local file from git      | Phase 0 checks; if it does not, Phase 4 prints one line telling the user to ignore it, and the README says the same.                                                                                                                                                                                                              |
| Path equality on Windows (case, `8.3` names, symlinks)                 | `DirectoryPath.same` folds case and separators over a `path.resolve`d cwd; short names and symlinks are two rows, and `uninstall`'s reconciliation collapses them once Claude is asked.                                                                                                                                           |
| An older build and `scoped.json`                                       | It never opens the file. `installed.json` is not touched by a scoped install.                                                                                                                                                                                                                                                     |
| Registrations made outside our records                                 | A user who ran `claude plugin install x@context-plugins-local --scope local` by hand has a registration no row names; `stagingShared` cannot see it and the last recorded row out unstages under them. Stated, and the same class as any hand edit of Claude's state.                                                             |
| A staged copy shared by two projects and refreshed by one              | Both point at one marketplace row; the later install's files win, as they do today for a re-install. Same source key by construction (the clash check), so it is the same plugin.                                                                                                                                                 |
| A stale row keeping a staged copy and a marketplace registration alive | Until an `uninstall` of that plugin reconciles it or `--force` clears it: one folder under `CP_STATE_DIR` and one `marketplace list` row. Accepted over a listing-driven delete in `update`.                                                                                                                                      |
| `update` spawning `claude` into many directories                       | One `plugin list` per directory, memoised in the session; only directories that exist are spawned into; a gone one is `unavailable` without a spawn. A directory on a disconnected share is a new way for `claude` itself to hang, and the runner's existing timeout is the answer.                                               |
| `stagingShared` computed before the loop going stale during it         | One plugin per run; the only writer of both files is this process.                                                                                                                                                                                                                                                                |
| The home rc setting `scope`                                            | A `Failure` naming the file, in `scope-resolution.ts`, with its own test.                                                                                                                                                                                                                                                         |
| Nobody uses it                                                         | The `scope` property says so within a release or two, and the flag costs nothing to keep. If a quarter of installs are `local`, the default is the next conversation.                                                                                                                                                             |

## Out of scope

- **`project` scope.** Cut by the review: it writes a committed file on the user's behalf,
  needs a "shareable source" rule (the generated marketplace cannot be named in a file
  other machines read), the "commit this" prose and the `disable --scope local` hint, and
  serves distribution. When it is wanted: one enum word, `PluginSource.shareable`, and the
  refusal for folder and repository sources at that scope.
- Cursor and VS Code project scopes. Each is one `scopes` declaration and one harness
  change away when Cursor documents `.cursor/settings.json` or ships an install command,
  and when microsoft/vscode#315123 lands.
- `--scope` on `update` or `installed` as a filter.
- A committed "this repo uses these plugins" declaration installed on each developer's
  machine (`sync`). It is the distribution story, and a different plan.
- The inverse - install at `user` and write `enabledPlugins: { x: false }` into other
  projects. A denylist that defaults to loaded is the opposite of isolation.
- Installing a folder plugin into `.claude/skills/<name>/`. It is Claude's native route
  and needs no marketplace, but it puts the files in the user's repository, and monitors
  and MCP are restricted there. Worth knowing as the thing a user can do by hand.
- Moving `~/.context-plugins/installed.json` rows into `scoped.json`. User-scope rows are
  the machine-wide record and stay where every build can read them.

## What the reviews changed

The first draft of this document, earlier on 2026-09-16, was reviewed adversarially twice.
What moved, and why, so the next reader does not re-derive it.

**First review**

1. **A spike before code.** Four documented behaviours of `claude` were load-bearing and
   untested by this project; each changes the design if wrong. Phase 0.
2. **`project` scope cut.** Scope creep against the stated goal of isolation, with its
   own rule and prose; one enum word away when wanted.
3. **The recorded path is a hint, not a key.** Claude's own placement rule for
   `.claude/settings.local.json` is "git root, except on Windows and in four other cases",
   which no recorded path can mirror. `uninstall` acts on cwd and asks Claude; `update`
   reconciles rows against Claude's listing and clears what it no longer holds.
4. **The source clash is checked across both records for every directory origin.** The
   first draft exempted scoped rows, which would have let two same-named folders overwrite
   one another's staged copy in silence.
5. **Uninstall is cwd-only.** "Infer when unique" was a wrong-target hazard for scripts and
   an `ENOENT` for a directory that has gone.
6. **`installed --json` stays one array.** The two-array object was a self-inflicted break
   for every existing reader.
7. **The case for the feature leads with this tool's own plugins** - SDK plugins are
   per-project by nature - and names Claude's three native alternatives honestly,
   including the skills directory, which the first draft's "`claude` alone cannot install a
   folder as a plugin" overlooked.

**Second review**, of the revised draft:

1. **Uninstall honours "Claude is the truth" too.** The revision keyed `uninstall` on a
   row at cwd while declaring the row a hint - so an install from a subfolder could not be
   removed from the repository root where Claude had put it. It now proceeds on a cwd row
   **or** Claude's listing from cwd, and reconciles the plugin's other rows afterwards.
2. **A directory that has gone can be cleared.** cwd-only had left such a row permanent,
   with no cwd to run from. `--force` clears it from anywhere as a record-only edit.
3. **`update` never deletes on a listing alone.** A different `CLAUDE_CONFIG_DIR` or an
   untrusted directory answers "nothing" for every row; the revision would have emptied
   `scoped.json` in one run. `update` now reports and keeps; deletion follows only the
   run's own uninstall. Phase 0 gained the trust question.
4. **The machine-wide warning.** Every existing user has the plugin at `user` scope, where
   a `local` install isolates nothing. `install --scope local` says so and prints the
   uninstall - the migration path the revision had no line for.
5. **The rc default reaches `uninstall`.** An rc that made installs local but not
   uninstalls would have `uninstall my-sdk` look machine-wide and point at the very
   directory it ran in.
6. **One `plugin list` per directory.** The session memoises `listPlugins(cwd)`, so
   `update` does not grow by a `claude` start-up per row.
7. **The CI arm asserts where the local file landed**, not only what the listing says,
   and the plan states that Windows placement is verified once by hand.
8. Phase 2 was split back into the harness change and the record file, one idea each.
