---
name: add-harness
description: Add support for a new editor or AI coding assistant ("harness") to context-plugins - a new install target alongside Claude Code, Cursor, and VS Code. Use this whenever the user mentions supporting another editor or assistant (Zed, JetBrains, Windsurf, Copilot CLI, Codex, Gemini CLI, ...), a new --targets value, "install into X", or a new place plugins should land, even if they never say "harness". Also use it when reviewing or fixing a harness that was added by hand, to check nothing on the list was missed.
---

# Add a harness

A harness is one editor's install strategy: how to tell it is on this machine, where its
plugins go, how to put one there and take it away. The registry is `src/harness/index.ts`;
`Harness` in `src/types.ts` is the contract. Everything else in the program - prompts,
`doctor`, `list`, `update`, the manifest - already iterates the registry, so most of the
work is the module itself plus the places that spell out editor names by hand.

## Pick the shape first

Read both existing shapes before writing anything; the new one is a copy of whichever
matches, not a fresh design.

| The editor...                                      | Template                                                                                                       | `needsSource` |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| loads plugins from a folder on disk                | `src/harness/cursor.ts` (plain copy) or `src/harness/vscode.ts` (copy + registers the path in a settings file) | `true`        |
| has its own CLI that installs from the marketplace | `src/harness/claude.ts`                                                                                        | `false`       |

`needsSource: true` means `install.ts` clones or downloads the plugin folder first and
hands the harness `ctx.srcDir`. `false` means the harness never sees the files and must
not ask for them.

## Steps

Work in this order: the type goes first so the compiler enumerates the rest.

1. **Add the name to `HarnessName` in `src/types.ts`.** Kebab-case, short, the thing a
   user would type after `--targets`. Then run `npm run typecheck`: `BY_NAME` in
   `src/harness/index.ts` is a `Record<HarnessName, Harness>`, so it now fails to compile
   until the harness exists and is registered. That error list is the checklist for the
   code; the docs and CI items below are what the compiler cannot see.

2. **Add the editor's directories to `src/paths.ts`.** One function for the directory
   that proves the editor is installed (what `detect` checks) and one for where plugins
   go, if they differ. Two rules, both already visible in the file:
   - Every function takes `PathOpts` and joins with `c.p` (the _target_ platform's
     joiner), with a `win32` / `darwin` / other branch where the editor's location
     differs by OS. This is what lets `test/paths.test.ts` assert the Windows path from a
     Linux runner.
   - Honour a `CP_<EDITOR>_DIR` env override before the default, like `CP_CURSOR_DIR`
     and `CP_VSCODE_USER_DIR`. Tests and the CI smoke job build a sandboxed machine
     from these; without one, the new harness can only be tested against the developer's
     real editor.

3. **Write `src/harness/<name>.ts`** by copying the template and changing what differs.
   Keep the contract the copy already follows:
   - `name: HarnessName`, `title` (what the user sees: "Install into <title>?"),
     `needsSource`.
   - `detect(opts)` is cheap and side-effect free; `location(opts)` returns where it
     looked, because that string is printed as "not installed (looked in ...)" and shown
     by `doctor`. Run both through `shortPath` so the user's home reads as `~`.
   - `install` returns `false` to mean "skipped, and said why" - not installed, nothing to
     do. A failure the user can fix is a thrown `UserError` with a `hint`. Never throw a
     bare `Error` for a predictable condition.
   - `uninstall` is idempotent: nothing to remove is `log.info` + `return false`, not an
     error. `update` and repeated uninstalls depend on this.
   - Copy files with `replaceDir` (wholesale replace), so a plugin that shrank between
     versions leaves no orphan files behind.
   - All output goes through `log`; end `install` and `uninstall` with the line that
     tells the user how to make the editor pick the change up (reload window, restart).
   - Treat anything read from the editor (a config file, a CLI's JSON output) as a JSON
     boundary: `isPlainObject` / `nonEmptyString` checks, never an `as` cast. If it edits
     a config file the user also edits by hand, splice text like `settings-merge.ts`
     does and take a backup first - do not parse-and-reserialize their file.

4. **Register it in `src/harness/index.ts`**: import it, add it to `HARNESSES` (this is
   the canonical order - how targets are listed in help, prompts, and the manifest) and
   to `BY_NAME`. Export it with the others. The typecheck from step 1 goes green here.

5. **Tests.** Copy the pattern nearest the shape:
   - `test/paths.test.ts`: a row per platform for each new path function, including the
     env override.
   - A CLI-driven harness gets `test/<name>.test.ts` modelled on `test/claude.test.ts`: a
     `fakeCli` that records argv and a PATH stub, so the real binary is never run.
   - A file-based harness joins the sandboxed machine: add its `CP_<EDITOR>_DIR` to
     `machine()` in **both** `test/install.test.ts` and `test/doctor.test.ts` (each has
     its own), and to `TARGETS` in `install.test.ts`. Leave `claude` out of `TARGETS` -
     it shells out to whatever `claude` is on the test runner's PATH. Check the
     "no editor at all" tests in both files still remove every editor directory.
   - The claude harness stays in every `NAMES`-driven expectation
     (`test/cli.test.ts`, "targets resolve to canonical order"); update those lists.

6. **The hand-written editor lists.** These are prose, so nothing enforces them; the
   compiler is silent and the old text simply stays wrong. Update every one:
   - `src/cli.ts` - the first line of `helpText` ("install marketplace plugins into ...").
     The `--targets` line under it is generated from `NAMES` and needs nothing.
   - `src/install.ts` - the "No supported editor found" hint and the "Nothing was
     changed. Are ... installed?" warning in `summarize`.
   - `src/doctor.ts` - the "Any editor" failure hint.
   - `README.md` - the intro sentence, the **Requirements** bullet (each editor's
     prerequisite is listed there), and the `--targets` row of the options table.
   - `CLAUDE.md` - the "What this is" paragraph.
   - `package.json` - `description` and, if the editor has a well-known name, `keywords`.
   - To find the code and config sites (six today), run
     `grep -rnE "Claude Code, Cursor|Cursor, (and|or) VS Code|Cursor / VS Code" src CLAUDE.md package.json`.
     It does **not** find the README - its editor names are bold-wrapped and backticked -
     so read the three README places by eye.

7. **CI smoke test** (`.github/workflows/ci.yml`, job `smoke`). A file-based harness
   should join the real install there: export its `CP_<EDITOR>_DIR`, `mkdir -p` it, add
   the name to both `--targets` lists, and assert on the artifact it leaves behind (the
   VS Code line checks `settings.json` exists). A CLI-driven harness cannot run there -
   the runner has no such binary - and is covered by its fake-CLI tests instead.

8. **Gate**, in this order, before committing:
   `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
   then `node bin/cli.js doctor` to see the new editor listed, and if it is installed on
   this machine, a real `node bin/cli.js install <plugin> --targets <name>` followed by
   `uninstall`.

## Compatibility note for the PR

The manifest records target names. An **older** CLI reading a row that names the new
harness treats the row as one it cannot act on: it keeps it on disk, reports it as ignored
in `installed` and `doctor`, and counts it as a failed row in `update`. That is the
designed behavior (see `src/manifest.ts`), not a bug - but say so in the PR description,
because it is the one user-visible effect on people who have not upgraded yet.

## Commit

`feat(harness): add <Editor>` - a new install target is a feature, so this is a minor
release when it lands on main. One commit for the harness and its tests; docs and CI
changes ride in the same commit, since the feature is not complete without them.
