# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`context-plugins` installs plugins from a plugin marketplace (a GitHub repo carrying a
`.claude-plugin/marketplace.json` registry) into Claude Code, Cursor, and VS Code with one
command. Published to npm; users run it via `npx`. The README is end-user documentation
only, by explicit decision — contributor and agent knowledge belongs here, not there.

## Commands

- `npm test` — full suite (node:test; needs no dependencies installed)
- `node --test test/manifest.test.js` — one test file
- `npm run lint` / `npm run lint:fix` — eslint 9 flat config + sonarjs bug rules
- `npm run format:check` / `npm run format` — prettier
- `npm run syntax` — bare `node --check` of the entry points (what pre-18 Node hits first)

There is no build step: the package ships `src/` as-is and `bin/cli.js` runs it directly.

## Hard constraints

- **Zero runtime dependencies, ever.** This is the package's identity: `npx` starts
  instantly, the shipped source is auditable, and the CI test matrix runs _without_
  `npm ci` on purpose. Hand-roll instead of installing (see `which()`, `pool()`, the
  boundary validators). devDependencies are fine.
- **Commit types are release decisions.** semantic-release publishes to npm from commit
  messages: `fix:` / `feat:` / `perf:` trigger a release; `refactor:` / `chore:` /
  `docs:` / `style:` do not. commitlint enforces conventional commits on every PR.
- **Never `shell: true`.** Spawning goes through `util.run()`, which routes Windows
  `.cmd` shims through cmd.exe with explicit quoting (Node refuses to spawn `.cmd`
  directly since the CVE-2024-27980 hardening).
- **All terminal output goes through `src/log.js`** — no `console.log` elsewhere.
  Glyphs are built from char codes with ASCII fallbacks for legacy Windows consoles;
  keep the source itself ASCII.
- **Validate at the edges, never cast.** Anything crossing a JSON boundary (manifest,
  registry, rc file, `claude` CLI output) or entering argv/URLs (plugin, repo, ref) is
  validated where it enters. The manifest drops bad entries silently (it is a state
  file; start-clean rule), the rc file fails loudly naming the file (it is user-written
  configuration). Keep that split.
- **eslint-plugin-sonarjs stays on v1.** From v2 it bundles the full Sonar analyzer,
  which requires a TypeScript peer and crashes against TypeScript 7.

## Architecture

Every command flows `bin/cli.js` → `src/cli.js` (arg parsing and rendering only) →
`src/install.js` (orchestration) → the harness that owns each editor.

- **Harnesses** (`src/harness/`): one module per editor implementing
  `{name, title, detect, location, install, uninstall, needsSource}`;
  `harness/index.js` is the registry. Claude Code installs through the `claude` CLI
  from the marketplace itself (`needsSource: false`); Cursor and VS Code copy files
  and need the fetched source. Adding an editor = one new module, one array entry,
  one test file.
- **Session** (`src/session.js`): work shared by every plugin in one run — the
  registry fetch, the repo clone, the Claude marketplace registration — each done
  once, keyed `repo@ref`. Promises are cached rather than results, so concurrent
  callers share one request and a deterministic failure is not retried. `update`
  threads one session through all plugins; a lone `install` gets a throwaway one.
- **The test seam is dependency injection, everywhere.** `deps` carries
  `fetchImpl` / `run` / `materialize` / `confirm`; `pathOpts` carries
  `platform` / `env` / `home`. Tests build a sandboxed "machine" from env overrides
  (`CP_STATE_DIR`, `CP_CURSOR_DIR`, `CP_VSCODE_USER_DIR`) and assert on real files.
  Never touch the developer's real home directory in tests; never add I/O that
  bypasses these seams.
- **`src/paths.js`** resolves paths for the _target_ platform (`path.win32` /
  `path.posix` chosen by the `platform` override, not the host), so Windows paths are
  exactly assertable from Linux CI.
- **State** is one file, `~/.context-plugins/installed.json` (`src/manifest.js`),
  entries keyed repo+plugin because the same plugin id can exist in two marketplaces.
  Entries are sanitized on read; an entry with zero known targets must be _dropped_,
  never kept as `targets: []` — `resolveTargets` reads an empty list as "every
  harness".
- **VS Code settings** (`src/settings-merge.js`) are JSONC. Edits are targeted string
  splices, never parse-and-reserialize, so user comments and formatting survive. A
  backup is taken before every mutation.
- **Configuration** resolves flag → `CP_*` env → `.contextpluginsrc` (cwd, then home)
  → preset profile → defaults (`src/brand.js`). `run.js` exists so another brand can
  ship this CLI preconfigured.

## TypeScript port (in progress)

`src/types.d.ts` is the type model the port builds on — keep it in sync when behavior
changes. Ground rules already decided: no runtime deps for validation (no zod), no
`as`-casts at JSON boundaries, tests must run without a build step (`tsx --test`
importing from `src/`), and oclif/clack were considered and rejected — the hand-rolled
parser and prompt flow stay.
