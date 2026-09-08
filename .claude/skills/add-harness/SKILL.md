---
name: add-harness
description: Add support for a new editor or AI coding assistant ("harness") to context-plugins - a new install target alongside Claude Code, Cursor, and VS Code. Use this whenever the user mentions supporting another editor or assistant (Zed, JetBrains, Windsurf, Copilot CLI, Codex, Gemini CLI, ...), a new --targets value, "install into X", or a new place plugins should land, even if they never say "harness". Also use it when reviewing or fixing a harness that was added by hand, to check nothing on the list was missed.
---

# Add a harness

A harness is one editor's install strategy: how to tell it is on this machine, where its
plugins go, how to put one there and take it away. The registry is
`src/harnesses/index.ts`; `Harness` in `src/types/harness.ts` is the contract. A harness
never prints: it reports what it did as a `HarnessEvent` and `src/prompts/harness/` holds
the words. Everything else in the program - `doctor`, `list`, `update`, the manifest -
already iterates the registry, so most of the work is the class, its lines, and the
places that spell out editor names by hand.

Four sibling skills own the rules this one only points at, and they are worth
reading rather than inferring from the template: `service` for anything the
harness does to the machine, `event` for the kinds it emits, `prompts` for the
words those become, and `value-object` for anything it validates. This document
is the checklist for an editor specifically - the parts the compiler cannot
flag.

## Pick the shape first

Read both existing shapes before writing anything; the new one is a copy of whichever
matches, not a fresh design.

| The editor...                                      | Template                                                                                                           | `needsSource` |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- |
| loads plugins from a folder on disk                | `src/harnesses/cursor.ts` (plain copy) or `src/harnesses/vscode.ts` (copy + registers the path in a settings file) | `true`        |
| has its own CLI that installs from the marketplace | `src/harnesses/claude.ts`                                                                                          | `false`       |

`needsSource: true` means `actions/install.ts` clones or downloads the plugin folder first and
hands the harness `ctx.srcDir`, a `DirectoryPath` - so ask it for `srcDir.file(...)`
rather than reaching for `node:path`. `false` means the harness never sees the files and
must not ask for them.

## Steps

Work in this order: the type goes first so the compiler enumerates the rest.

1. **Add the name to `HarnessName` in `src/types/harness.ts`.** Kebab-case, short, the thing a
   user would type after `--targets`. Then run `npm run typecheck`: three
   `Record<HarnessName, ...>` tables now fail to compile until the editor is in all of
   them - `TITLES` in the same file, which is where its display name goes and what
   `NAMES`, `titlesOf` and `everyEditor` are derived from; `RELOAD` in
   `src/prompts/harness/editor.ts`, which is the line telling a user how to make the
   editor pick the change up; and the object passed to `new HarnessRegistry` in
   `src/harnesses/index.ts`, which needs the class. That error list is the checklist for
   the code; the docs and CI items below are what the compiler cannot see.

2. **Add the editor's directories to `src/infrastructure/paths.ts`.** One function for the directory
   that proves the editor is installed (what `detect` checks) and one for where plugins
   go, if they differ. Two rules, both already visible in the file:
   - Every function takes `PathOpts` and returns a `DirectoryPath` or `FilePath` built
     from `ctx(o).rules` and `join` / `file` - the _target_ platform's rules, not the
     host's - with a `win32` / `darwin` / other branch where the editor's location
     differs by OS. This is what lets `test/infrastructure/paths.test.ts` assert the
     Windows path from a Linux runner.
   - Honour a `CP_<EDITOR>_DIR` env override before the default, like `CP_CURSOR_DIR`
     and `CP_VSCODE_USER_DIR`. Tests and the CI smoke job build a sandboxed machine
     from these; without one, the new harness can only be tested against the developer's
     real editor.

3. **Write `src/harnesses/<name>.ts`** by copying the template and changing what
   differs. Keep the contract the copy already follows:
   - A class implementing `Harness`, with `name: HarnessName`, `title` (`TITLES.<name>` -
     the string itself lives in `types/harness.ts`, so prose that lists editors and the
     harness itself cannot disagree), `needsSource`.
   - `detect(opts)` is cheap and side-effect free; `location(opts)` returns the
     `DirectoryPath` it looked at, which the caller prints as "not installed (looked in
     ...)" and `doctor` shows. Do not shorten it here: a harness cannot reach
     `prompts/format.ts`, and eslint refuses the import.
   - `install` returns `Result<InstallOutcome, Failure>`: `ok('installed')`,
     `ok('skipped')` for "not installed, nothing to do, and said why", and
     `err(new Failure(message, hint))` for an editor that looked and could not. Never
     throw for any of the three. A throw out of a harness is a bug by definition - the
     run reports it as `error_kind: 'unexpected'` and prints a stack under `--verbose` -
     while a returned `Failure` is the user's to fix and is counted as `user`. Both
     outcomes are truthy strings inside a truthy object, so nothing may test the result
     for truth: read the arm, then the value.
   - `uninstall` returns `'removed' | 'absent' | 'skipped' | 'failed'`, never a
     boolean, and the difference decides whether the manifest row survives AND whether
     the command fails. `absent` means the harness LOOKED and established there is
     nothing to remove - only then is the target cleared from the record. `skipped` is
     "could not look": your editor is not installed, or there is no path or name to
     address it by. `failed` is "looked and it went wrong". Both keep the row, but only
     `failed` makes the command exit non-zero - so never return it for an editor that
     simply is not there. Getting `absent` wrong the other way deletes the record for a
     plugin that is still installed, with nothing left to remove it by. Repeated
     uninstalls and `update` depend on `absent` being reachable; `--force` is the user's
     escape for a target stuck on `skipped` or `failed`.
   - Copy files with `replaceDir` (wholesale replace), so a plugin that shrank between
     versions leaves no orphan files behind.
   - **It says nothing itself.** Every line is
     `ctx.listener({ harness: '<name>', kind, ... })`, carrying facts - a path, an exit
     code, the tail of some output - and never a sentence. Emit at the moment the thing
     happens rather than from what a function returns: a line explaining a wait is only
     useful before it, and a memo that caches the work then says it as often as the work
     is done. End `install` and `uninstall` with
     `{ kind: 'reload', after: 'install' | 'uninstall' }`. The `event` skill has the
     rest of that rule, including the two bugs behind it.
   - **Reach the machine through `src/infrastructure/`,** not through `node:fs` or
     `node:child_process` directly - `replaceDir` from `file-system.ts`, `run` and
     `which` from `process-runner.ts`, and a new module there if the editor needs
     something none of them does. See the `service` skill; a harness may import that
     directory, which is exactly why it should not reimplement it.
   - Treat anything read from the editor (a config file, a CLI's JSON output) as a JSON
     boundary: `isPlainObject` / `nonEmptyString` checks, never an `as` cast. If it edits
     a config file the user also edits by hand, splice text like
     `infrastructure/vscode-settings.ts`
     does and take a backup first - do not parse-and-reserialize their file.

4. **Give it words in `src/prompts/harness/`** (and read the `prompts` skill first).
   Add its `RELOAD` entry in `editor.ts`,
   then - only if it says anything no other editor says - a `<name>.ts` with one case per
   kind of its own and a `default` that hands the rest to `announceEditor`, plus a case in
   the switch in `index.ts`. A file-copying editor may need nothing but the `RELOAD`
   entry: the six lines Cursor and VS Code share are one template each in `editor.ts`
   with the title filled in, and a seventh copy of any of them is the drift `TITLES`
   exists to prevent. Add the event type to `types/harness.ts` in the same shape as
   `CursorEvent` - `{ harness: '<name>' }` intersected with `CopyEvent` and whatever is
   its own.

5. **Register it in `src/harnesses/index.ts`**: import the class and add an instance to
   the object passed to `new HarnessRegistry`. The typecheck from step 1 goes green here.
   There is nothing else to add: `all()` walks `NAMES`, and the canonical order - how
   targets are listed in help, prompts, and the manifest - is the order of the keys in
   `TITLES`, back in `src/types/harness.ts`.

6. **Tests.** Copy the pattern nearest the shape:
   - `test/infrastructure/paths.test.ts`: a row per platform for each new path function, including the
     env override.
   - `test/harnesses/<name>.test.ts`, modelled on the file for the shape it copied. A
     file-based harness follows `cursor.test.ts` or `vscode.test.ts`: a `machine()` built
     from `CP_<EDITOR>_DIR`, asserting the events, the return value and the files left
     behind. A CLI-driven one follows `claude.test.ts`: a `fakeCli` that records argv and
     a PATH stub, so the real binary is never run.
   - **A row per event kind in `test/prompts/harness.test.ts`.** That table is where the
     words a user reads are pinned, and its own test refuses an editor that appears in
     `NAMES` with no case there.
   - A file-based harness joins the sandboxed machine: add its `CP_<EDITOR>_DIR` to
     `machine()` in **both** `test/install-fixture.ts` (shared by every install-shaped
     test) and `test/actions/doctor.test.ts` (which has its own), and to `TARGETS` in the
     fixture. Leave `claude` out of `TARGETS` - it shells out to whatever `claude` is on
     the test runner's PATH. Check the "no editor at all" tests in both files still
     remove every editor directory.
   - The claude harness stays in every `NAMES`-driven expectation
     (`test/commands/router.test.ts`, "targets resolve to canonical order"); update those
     lists.

7. **The hand-written editor lists.** These are prose, so nothing enforces them; the
   compiler is silent and the old text simply stays wrong. Update every one:
   - The code needs nothing: every editor list in `commands/help.ts`, the prompts
     classes, `actions/doctor.ts` and the uninstall decision comes from `everyEditor()` /
     `titlesOf()` in `types/harness.ts`. Do not hand-write a new one anywhere - the
     install summary and the uninstall summary are separate functions in separate files,
     and a list added to one would silently go stale in the other.
   - `CLAUDE.md` - the "What this is" paragraph.
   - `package.json` - `description` and, if the editor has a well-known name, `keywords`.
   - To find every remaining hand-written list, run
     `grep -rnE "Claude Code, Cursor|Cursor, (and|or) VS Code|Cursor / VS Code" src CLAUDE.md package.json`.
     Two today, both prose - `CLAUDE.md` and the `package.json` description - because the
     code's lists are all derived now. If that grep ever finds one under `src/`, it is a
     hand-written list that will go stale: replace it with `everyEditor()`.
     It does **not** find the README - its editor names are bold-wrapped and backticked -
     so work the README by eye, all five places:
     - the intro sentence;
     - the **Requirements** bullet, where each editor's prerequisite is listed;
     - the `--targets` row of the **Options** table;
     - the detection paragraph in **Choosing where to install**, which says which
       editors are found on `PATH` and which by their user directory;
     - a row in the **What it does per assistant** table - the README's only
       description of what a harness actually does, giving mechanism and install
       location. A harness missing from it is undocumented for users.

8. **CI smoke test** (`.github/workflows/ci.yml`, job `smoke`). A file-based harness
   should join the real install there: export its `CP_<EDITOR>_DIR`, `mkdir -p` it, add
   the name to both `--targets` lists, and assert on the artifact it leaves behind (the
   VS Code line checks `settings.json` exists). A CLI-driven harness cannot run there -
   the runner has no such binary - and is covered by its fake-CLI tests instead.

9. **Gate**, in this order, before committing:
   `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
   then `node bin/cli.js doctor` to see the new editor listed, and if it is installed on
   this machine, a real `node bin/cli.js install <plugin> --targets <name>` followed by
   `uninstall`.

## Compatibility note for the PR

The manifest records target names, so a build released before the new harness existed
meets a name it does not know. What it does depends on the rest of the row, and the two
cases differ enough that the PR description should say which one applies:

- **Every target on the row is unknown** - someone installed into the new editor only.
  The row is one that build cannot act on, so it keeps it on disk, reports it as ignored
  in `installed` and `doctor`, and counts it as a failed row in `update`.
- **The row mixes the new name with an editor it does know** - the common shape, because
  a default install records every editor it found. The row is acted on normally for the
  targets it understands, and the new name rides through the rewrite untouched.

Both are the designed behavior, not a bug: `manifestView` in
`src/types/installed-record.ts` hides what this build cannot represent, and
`ManifestContext.recordInstall` puts the foreign names back on the way to disk. Say so in
the PR description - it is the one user-visible effect on people who have not upgraded.

## Commit

`feat(harness): add <Editor>` - a new install target is a feature, so this is a minor
release when it lands on main. One commit for the harness and its tests; docs and CI
changes ride in the same commit, since the feature is not complete without them.
