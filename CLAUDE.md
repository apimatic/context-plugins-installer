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

## Architecture

Every command flows `bin/cli.js` → `src/cli.ts` (arg parsing and rendering only) →
`src/install.ts` (orchestration) → the harness that owns each editor. `src/types.ts`
is the type model for the whole surface; keep it in sync when behavior changes.

- **Harnesses** (`src/harness/`): one module per editor implementing the `Harness`
  interface (`name`, `title`, `detect`, `location`, `install`, `uninstall`,
  `needsSource`); `harness/index.ts` is the registry, and `byName` is total over
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
  `platform` / `env` / `home`. Tests build a sandboxed "machine" from env overrides
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
  harness". The same rule holds _within_ a row: writers rebuild from the raw record
  (`findRaw` + `foreignTargets`), so a target name or field belonging to a newer CLI
  survives a rewrite. Never write a row back from the sanitized view. `installed` and
  `doctor` warn about both losses — on stderr under `--json`, so the payload stays
  parseable, and silenced by `--quiet` like any other warning. `list` and `update`
  still narrow rows without saying so; both would need the two lists threaded through
  `listPlugins`/`updateAll`.
- **VS Code settings** (`src/settings-merge.ts`) are JSONC. Edits are targeted string
  splices, never parse-and-reserialize, so user comments and formatting survive. A
  backup is taken before every mutation.
- **Configuration** resolves flag → `CP_*` env → `.contextpluginsrc` (cwd, then home)
  → preset profile → defaults (`src/brand.ts`). `run.js` exists so another brand can
  ship this CLI preconfigured.

## Decisions already made

- No zod or any runtime validation library: validators are hand-rolled.
- No oclif, no clack: the parser is a typed flag table in `cli.ts` and the prompt flow
  is `prompt.ts`; both were weighed against the org's apimatic-cli stack and rejected
  to keep the package dependency-free.
- `--help` and `doctor` still resolve the brand before running, so a broken rc file
  blocks them; `--version` does not. Restructuring that is open work.
