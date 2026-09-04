# context-plugins Layering Plan

Moving the installer onto the command / action / prompts / infrastructure / types
boundaries that apimatic-cli uses, in eight phases that each leave the suite green.

All eight land on one branch, `saeedjamshaid/layering-refactor`, as a single pull
request against `main`. That is a change from what this document first said: the
phases were planned as sixteen stacked pull requests, and stacking them through
squash merges cost more than reviewing them in order does. The phase is still the
unit of review, and each is a run of self-contained commits.

| Date       | Base             | Source      | Tests               | Reference          |
| ---------- | ---------------- | ----------- | ------------------- | ------------------ |
| 2026-09-04 | `main @ a351689` | 4,411 lines | 283 across 16 files | apimatic-cli 1.3.1 |

Contents

1. [Decisions already made](#decisions-already-made)
2. [What the reference actually does](#what-the-reference-actually-does)
3. [Where this repo is today](#where-this-repo-is-today)
4. [Target architecture](#target-architecture)
5. [The shared kernel](#the-shared-kernel)
6. [What an action reads like afterwards](#what-an-action-reads-like-afterwards)
7. [How a harness talks without a terminal](#how-a-harness-talks-without-a-terminal)
8. [File map](#file-map)
9. [Test map](#test-map)
10. [Phases](#phases)
11. [Rules that hold for every PR](#rules-that-hold-for-every-pr)
12. [Risks and how each is held](#risks-and-how-each-is-held)
13. [Out of scope](#out-of-scope)

## Decisions already made

These were settled before the plan was written. Everything below assumes them; change one
and the affected phase changes with it.

| Decision       | Choice                              | Why                                                                                                               |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Dependencies   | Zero at runtime, hand-rolled kernel | ActionResult, Result and the prompts layer are written in-repo. No oclif, clack or neverthrow.                    |
| Modules        | CommonJS stays                      | bin/cli.js keeps its require; relative imports keep the `.js` suffix they already carry; Node 18 floor untouched. |
| Injection      | Constructor injection               | Actions, contexts and harnesses receive their services. Tests pass fakes. No sinon, no prototype stubs.           |
| Library API    | Dropped                             | `src/index.ts` and package.json `main` / `types` / `exports` go. The CLI is the only consumer of its code.        |
| run.js         | Dropped, with Profile               | Brand config stays reachable through flags, `CP_*` env and `.contextpluginsrc`.                                   |
| Harness output | Listener port                       | Harnesses emit typed events; a prompts class turns them into prose. Progress stays live.                          |
| Telemetry      | Events fired from commands          | Actions return facts; commands map them to event classes; a service sends.                                        |
| Value objects  | Identifiers and paths               | PluginId, RepoSlug, GitRef, MarketplaceName, DirectoryPath, FilePath.                                             |

## What the reference actually does

apimatic-cli documents its layers in `.ai/instructions.md` and seven skill files. Reading
the code alongside them, the boundaries that matter are these.

- **Command** parses flags, converts them to typed values, builds a `CommandMetadata`, then
  runs exactly `intro -> action.execute -> outro(result)`. `outro` maps the result to
  `process.exitCode`. Telemetry events are fired here, from the result.
- **Action** is one class per command. The constructor takes what it needs; `execute` is an
  arrow property returning `ActionResult` and never throws. Every message goes through a
  paired Prompts class. Validation and file I/O go through Context objects.
- **Application** holds pure algorithms: data in, data out, no I/O, no prompts.
- **Prompts** is one stateless class per command over `@clack/prompts`. Four kinds of
  method: spinners, interactive prompts with a cancel guard, log lines, notes.
- **Infrastructure** services are silent and return `Result<T, ServiceError>` rather than
  throwing.
- **Types** hold value objects (private primitive, `toString` as the only exit,
  `static create()` for fallible construction), contexts (path derivation plus validation
  plus I/O for one concept, derived paths as private getters), DTOs, and past-tense domain
  events.

Three things the reference does that this plan deliberately does not copy, each tied to a
decision above:

- It creates services and prompts inline with `new` and tests by stubbing prototypes with
  sinon. This repo injects through constructors and keeps `node:test`.
- Its contexts import concrete `FileService` from infrastructure, so the types layer
  depends on the I/O layer. Here a context receives its store through the constructor,
  typed by a small port interface in `types/`.
- Its `ActionResult.failed()` carries only a message. Here every variant carries the
  action's **report**, because the command needs the facts of a failed run (which editors
  were reached, at what stage it stopped, how long it took) to fire telemetry from outside
  the action.

Also worth knowing before copying anything: its `ServiceError` imports the prompts
formatter, so infrastructure there depends on the UI layer; its `envInfo` is a mutable
singleton that tests reset by reaching into a private static; and its command-layer
telemetry carries a `// TODO: find a solution for tracking`. Those are the reference's
known gaps, not its pattern.

## Where this repo is today

The codebase is careful about the things it thinks about: validation at JSON boundaries,
cross-platform paths, the manifest's whole-or-null rules, a state-space test for the
uninstall decision. What it lacks is any boundary between deciding, doing, and saying.

| Symptom                                                                                                      | Where                                                                                 | Measure                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Terminal output is written from every layer, so no single file shows what a command does                     | `install.ts`, `cli.ts`, the three harnesses, `telemetry.ts`, `fetch.ts`, `catalog.ts` | 151 direct `log.*` calls in 8 files        |
| The argument parser also renders four commands' output and holds their logic                                 | `cli.ts`: the `list`, `doctor`, `installed` and `telemetry` cases                     | 452 lines, 44 output calls                 |
| Four commands' orchestration, the pure uninstall decision, prompting and telemetry plumbing share one module | `install.ts`                                                                          | 789 lines                                  |
| Expected failures are thrown from any depth and caught at the top; exit codes come from catch blocks         | `throw new UserError`                                                                 | 37 sites in 8 files                        |
| Test seams are threaded as options bags through every level                                                  | `deps` / `pathOpts` parameters                                                        | 43 mentions in install.ts, 26 in doctor.ts |
| Identifiers are raw strings; the marketplace-name rule is written twice                                      | `MARKETPLACE_RE` in `catalog.ts` and `doctor.ts`; `assert*` in `util.ts`              | 4 identifier kinds, 0 types                |
| Rules about a manifest row live in two modules that must agree                                               | `sanitizeEntry` in `manifest.ts`, `rowShape` and the rebuild in `install.ts`          | 2 views of one concept                     |
| Home-directory shortening for display is called wherever a path is printed                                   | `shortPath(...)`                                                                      | 24 call sites                              |
| All types in one file                                                                                        | `types.ts`                                                                            | 359 lines                                  |

**Keep, do not rebuild.** Zero dependencies. Injection through seams. `decideUninstall` and
its exhaustive test. Path resolution by target platform in `paths.ts`. The whole-or-null
reading of Claude's plugin listing. JSONC splicing in `settings-merge.ts`. The
promise-cached session. Every one of these moves to a new home verbatim; none is
redesigned.

## Target architecture

Six directories under `src/`, each allowed to import from a fixed set of the others. The
arrows below are the whole rule; a lint rule enforces them from Phase 7.

```
                    +-------------------------------+
                    | commands/                     |  args, help, router, one file per command
                    +---------------+---------------+
      intro, outro, usage errors    | construct, execute
              +---------------------+
              |                     v
              |     +-------------------------------+
              |     | actions/                      |  one class per command; returns ActionResult<Report>
              |     +----+-----------+----------+---+
              |          | decide    | install, | manifest, registry, source
              v          v           v uninstall|
        +----------+ +--------------+ +------------+
        | prompts/ | | application/ | | harnesses/ |
        +----------+ +--------------+ +-----+------+
                                            | editor I/O
                                            v          v
                                     +---------------------+
                                     | infrastructure/     |
                                     +----------+----------+
                                                v
   +----------------------------------------------------------------------+
   | types/  value objects, ports, contexts, events, Result, Failure       |
   +----------------------------------------------------------------------+
     every layer imports types/; types/ imports nothing but node:path and node:url

   Removed edges that exist today: harnesses -> terminal, infrastructure -> terminal.
```

| Directory         | May import                                                                                | Must not import                                           | Owns                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `commands/`       | actions, prompts (format, terminal config), types, composition                            | infrastructure directly, harnesses, application           | flag table, help, router, one command class each; fires telemetry events from reports |
| `actions/`        | application, harnesses, infrastructure (as constructor types), prompts (own class), types | `prompts/terminal`, commands                              | the flow of one command, top to bottom                                                |
| `prompts/`        | types, prompts/terminal, prompts/format                                                   | infrastructure, actions, harnesses, application, commands | every user-visible string; the only `console` in the codebase                         |
| `application/`    | types                                                                                     | everything else, node I/O                                 | pure decisions                                                                        |
| `harnesses/`      | infrastructure, types                                                                     | prompts, actions, commands                                | one editor's install policy, expressed as events and an outcome                       |
| `infrastructure/` | types, node builtins                                                                      | prompts, actions, harnesses, application, commands        | every file, process, network and state-file operation; returns `Result`, never prints |
| `types/`          | types, `node:path`, `node:url`                                                            | everything else                                           | value objects, ports, contexts, events, `Result`, `Failure`, `NAMES` and titles       |

### Directory tree

```
src/
  main.ts                        run(argv): Promise<number>  -- what bin/cli.js requires
  composition.ts                 builds the real Services once per run; tests build fakes
  commands/
    args.ts  help.ts  router.ts
    install.ts  uninstall.ts  update.ts  list.ts  installed.ts  doctor.ts  telemetry.ts
  actions/
    action-result.ts
    install.ts  uninstall.ts  update.ts  list.ts  installed.ts  doctor.ts  telemetry.ts
  application/
    uninstall-decision.ts        decideUninstall, uninstallLines -- moved verbatim
    plugin-resolution.ts         resolvePlugin without the fetch; suggest()
    target-selection.ts          resolveTargets; ask-or-take-all decision
    brand-resolution.ts          flag -> env -> rc -> defaults, over already-read sources
  prompts/
    terminal.ts  format.ts  prompter.ts  gaps.ts
    install.ts  uninstall.ts  update.ts  list.ts  installed.ts  doctor.ts  telemetry.ts  router.ts
    harness/claude.ts  cursor.ts  vscode.ts        HarnessListener implementations
  harnesses/
    index.ts                     HarnessRegistry over instances; byName, detect
    claude.ts  cursor.ts  vscode.ts
  infrastructure/
    file-system.ts  process-runner.ts  environment.ts  paths.ts
    rc-file.ts  manifest-store.ts  vscode-settings.ts
    github-registry-client.ts  source-fetcher.ts  session.ts  claude-cli.ts
    telemetry-state.ts  mixpanel-client.ts  telemetry-service.ts
  types/
    result.ts  failure.ts
    ids/plugin-id.ts  repo-slug.ts  git-ref.ts  marketplace-name.ts
    file/directory-path.ts  file-path.ts
    brand.ts  harness.ts  catalog.ts  session.ts  doctor.ts  reports.ts  telemetry.ts
    installed-record.ts          every rule about a manifest row, in one place
    manifest-context.ts          the state file as a domain object
    ports.ts                     ManifestStore, RegistryReader, SourceFetcher interfaces
    events/domain-event.ts  plugin-installed.ts  plugin-install-failed.ts
           plugin-uninstalled.ts  plugin-uninstall-failed.ts
```

## The shared kernel

Four small types carry the whole design. They are written once in Phase 0 and never grow a
dependency.

### Result and Failure

`Failure` is today's `UserError` as a value: a message the user can act on and an optional
hint. Infrastructure returns `Result<T, Failure>` for anything that can go wrong in the
world; it throws only for bugs. The router prints a thrown `Error` with its stack under
`--verbose` and exits 1, exactly as today.

```ts
export class Failure {
  constructor(
    readonly message: string,
    readonly hint?: string,
  ) {}
}

export type Result<T, E = Failure> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

### ActionResult

Every action returns one. All three variants carry the action's **report**, the facts of
the run, because the command fires telemetry from it whether or not the run succeeded. Exit
codes: 0 success, 1 failed, 130 cancelled. Usage errors never reach an action; the router
answers those with 2.

```ts
export class ActionResult<R> {
  static success<R>(report: R): ActionResult<R>;
  static failed<R>(report: R, failure: Failure): ActionResult<R>;
  static cancelled<R>(report: R): ActionResult<R>;

  readonly report: R;
  readonly failure: Failure | null;
  isSuccess(): boolean;
  isFailed(): boolean;
  isCancelled(): boolean;
  exitCode(): 0 | 1 | 130;
}
```

Reports are plain types in `types/reports.ts`. `InstallReport` carries `plugin`,
`installed: HarnessName[]`, `untouched`, `marketplace`, `ref`, `stage`, `targetsExplicit`
and `durationMs`: the same fields install.ts's `progress` object and `InstallResult` hold
today, in one place. `UninstallReport` carries the `UninstallDecision` itself.
`UpdateReport` carries one `InstallReport` per row, so the update command fires the same
events install does.

### HarnessEvent

A discriminated union of everything a harness can say while it works. The harness emits; a
prompts class writes prose. The strings that exist today move into the prompts class
unchanged.

```ts
export type HarnessEvent =
  | { kind: 'not-detected'; location: DirectoryPath | 'claude on PATH' }
  | { kind: 'marketplace-known-as'; known: MarketplaceName; configured: MarketplaceName }
  | { kind: 'marketplace-refreshing'; name: MarketplaceName }
  | { kind: 'marketplace-refresh-failed'; name: MarketplaceName; exit: number; detail: string }
  | { kind: 'marketplace-added'; name: MarketplaceName }
  | { kind: 'retrying-after-refresh'; target: string }
  | { kind: 'copied'; dest: DirectoryPath }
  | { kind: 'removed'; dest: DirectoryPath }
  | { kind: 'nothing-at'; dest: DirectoryPath }
  | {
      kind: 'settings-edited';
      file: FilePath;
      action: AddLocationAction | RemoveLocationAction;
      backup: FilePath | null;
    }
  | { kind: 'settings-unremovable'; file: FilePath; dest: DirectoryPath }
  | { kind: 'no-plugin-manifest' } // Cursor's .cursor-plugin/plugin.json is missing
  | { kind: 'cli-said'; stream: 'stdout' | 'stderr'; tail: string }; // --verbose detail

export type HarnessListener = (event: HarnessEvent) => void;
```

The outcome is still the return value: `Result<'installed' | 'skipped', Failure>` for
install and `Result<UninstallOutcome, Failure>` for uninstall, with `UninstallOutcome`
unchanged as `'removed' | 'absent' | 'skipped' | 'failed'`. A thrown error inside a harness
is still caught per harness by the uninstall action and recorded as `failed`, so one
editor's I/O failure never hides the others.

### Domain events

Telemetry's property names are a Mixpanel contract, so each event is a class whose
constructor types make it impossible to pass a path or a message. `plugin` is a
`PluginId | null`, never a string; the "only once validated" rule becomes a type.

```ts
export class PluginInstalledEvent extends DomainEvent {
  readonly name = 'Context Plugin Installed';
  constructor(
    private readonly plugin: PluginId,
    private readonly harness: HarnessName,
    private readonly marketplace: MarketplaceLabel, // the built-in repo, or 'custom'
    private readonly targetsExplicit: boolean,
    private readonly durationMs: number,
  ) {
    super();
  }
  properties() {
    return {
      plugin: this.plugin.toString(),
      harness: this.harness,
      marketplace: this.marketplace,
      targets_explicit: this.targetsExplicit,
      duration_ms: this.durationMs,
    };
  }
}
```

The four events are `PluginInstalled`, `PluginInstallFailed` (`plugin | null`,
`marketplace`, `stage`, `errorKind`), `PluginUninstalled` and `PluginUninstallFailed`.
Run-level properties (`command`, `cli_version`, `node_major`, `os`, `arch`, `ci`,
`interactive`, `run_id`) stay in the service, added at flush.

### Value objects

| Type                        | Replaces                                                                                       | Behaviour it owns                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PluginId`                  | `assertPlugin`, `isPluginId`, the telemetry guard                                              | `create()` with the kebab-case, 64-char rule; `isEqual`                                                                                                                                                                                                                                                           |
| `RepoSlug`                  | `assertRepo`, `REPO_IN` and `isSameRepo` in claude.ts, URL building in catalog.ts and fetch.ts | `cloneUrl()`, `rawUrl(ref, path)`, `treeUrl(ref)`, case-insensitive `matches()`, `fromListing(text)`                                                                                                                                                                                                              |
| `GitRef`                    | `assertRef`, `isSha`                                                                           | `isSha()` so the clone strategy can switch; `isDefault()` for the "from" label                                                                                                                                                                                                                                    |
| `MarketplaceName`           | both copies of `MARKETPLACE_RE`                                                                | `create()` with Claude's schema rule; the hint text about kebab-case lives with it                                                                                                                                                                                                                                |
| `DirectoryPath`, `FilePath` | 27 `path.join` sites, 24 `shortPath` sites                                                     | Carry the **target platform's** joiner (`path.win32` or `path.posix`), so `test/paths.test.ts` still asserts a Windows path from Linux. `join()`, `parent()`, `isEqual()`, `contains()` for the traversal check in the API download. Display shortening (`~`) is `f.path()` in prompts, not a method on the path. |

Every value object follows the reference's rules: private primitive, `toString()` as the
only way out, `static create()` returning `T | undefined` from untrusted input, direct
constructor for trusted callers. `.toString()` appears only at `fs`, `spawn`, `fetch` and
display sites.

## What an action reads like afterwards

The test of the whole exercise is whether a cold reader can open one file and see what
`install` does. This is the shape `actions/install.ts` takes; the strings and rules are
today's, only their location changes.

```ts
export class InstallAction {
  constructor(
    private readonly prompts: InstallPrompts,
    private readonly registry: RegistryReader, // session-backed: one read per repo@ref
    private readonly sources: SourceFetcher, // session-backed: one clone per repo@ref
    private readonly harnesses: HarnessRegistry,
    private readonly manifest: ManifestContext,
    private readonly prompter: Prompter,
    private readonly environment: Environment,
  ) {}

  readonly execute = async (req: InstallRequest): Promise<ActionResult<InstallReport>> => {
    const report = InstallReport.start(req);

    const resolved = await this.registry.resolve(req.brand, req.plugin);
    if (!resolved.ok) return ActionResult.failed(report.at('resolve'), resolved.error);
    this.prompts.resolved(resolved.value);

    const conflict = this.manifest.conflictFor(req.plugin, req.brand.repo);
    if (conflict && !req.force) return ActionResult.failed(report.at('harnesses'), conflict);

    const detected = this.harnesses.detect(req.targets);
    this.prompts.detected(detected);
    if (!detected.available.length) {
      return ActionResult.failed(report, noEditorFailure(detected, req));
    }

    const chosen = await this.choose(detected.available, req);
    if (chosen === 'cancelled') return ActionResult.cancelled(report);
    if (!chosen.length) {
      this.prompts.nothingChosen();
      return ActionResult.success(report);
    }
    this.prompts.installingInto(chosen);

    let source: DirectoryPath | null = null;
    if (this.harnesses.anyNeedsSource(chosen)) {
      const fetched = await this.sources.fetch(resolved.value);
      if (!fetched.ok) return ActionResult.failed(report.at('fetch'), fetched.error);
      source = fetched.value.dir;
      this.prompts.sourceReady(fetched.value);
    }

    for (const name of chosen) {
      this.prompts.beginHarness(name);
      const ctx = {
        plugin: req.plugin,
        marketplace: resolved.value.marketplace,
        repo: req.brand.repo,
        source,
        session: req.session,
        listener: this.prompts.harnessListener(name),
      };
      const outcome = await this.harnesses.byName(name).install(ctx);
      if (!outcome.ok) return ActionResult.failed(report.at('install'), outcome.error);
      if (outcome.value === 'installed') report.installed(name);
    }

    this.manifest.recordInstall(report, resolved.value); // keeps foreign targets and unknown fields
    this.prompts.summary(report);
    return ActionResult.success(report.finished());
  };
}
```

Notice what is **not** in it: no `log`, no `deps`, no telemetry, no `try` around the whole
thing, no manifest rebuild logic. The command that owns it is shorter still:

```ts
export class InstallCommand {
  async run(
    parsed: ParsedArgs,
    brand: Brand,
    services: Services,
  ): Promise<ActionResult<InstallReport>> {
    const plugin = PluginId.create(parsed.args[0] ?? services.environment.get('CP_PLUGIN'));
    if (!plugin) {
      return usageFailure(
        'No plugin specified.',
        `Usage: ${BIN} install <plugin>   (or set CP_PLUGIN)`,
      );
    }

    this.prompts.intro(plugin, brand, parsed.flags.ref);
    const action = new InstallAction(
      new InstallPrompts(),
      services.session,
      services.session,
      services.harnesses,
      services.manifest,
      services.prompter,
      services.environment,
    );
    const result = await action.execute({
      brand,
      plugin,
      ref: parsed.flags.ref,
      targets: parsed.targets,
      force: parsed.flags.force,
      assumeYes: parsed.flags.yes,
      session: services.session,
    });
    this.prompts.outro(result);

    for (const harness of result.report.installed) {
      services.telemetry.track(
        new PluginInstalledEvent(
          plugin,
          harness,
          brand.marketplaceLabel(),
          result.report.targetsExplicit,
          result.report.durationMs,
        ),
      );
    }
    if (result.isFailed()) {
      services.telemetry.track(
        new PluginInstallFailedEvent(
          plugin,
          brand.marketplaceLabel(),
          result.report.stage,
          errorKind(result.failure),
        ),
      );
    }
    return result;
  }
}
```

## How a harness talks without a terminal

Claude Code's install shells out up to five times; a silent stretch would read as a hang.
The listener port keeps progress live while the harness never learns what a terminal is.

```
  InstallAction         --install(ctx, listener)-->      ClaudeHarness        --list, add, update, install-->   ClaudeCli
  actions/install.ts    <--Result<outcome>--             harnesses/claude.ts  <--validated rows, exit codes--   infrastructure/claude-cli.ts
                                                               |
                                                               | HarnessEvent, as each step lands
                                                               v
                                                         ClaudePrompts
                                                         prompts/harness/claude.ts
                                                         (the action supplies this as ctx.listener)

  The harness never imports prompts/. The prompts class never imports the harness.
  The action wires one into the other per call.
```

Each existing message ("Marketplace 'x' is already registered - updating it.") becomes one
`case` in that prompts class, string unchanged.

The split inside `harness/claude.ts` is the one place policy and I/O have to be pulled
apart by hand:

- **Infrastructure** (`claude-cli.ts`): `listMarketplaces()`, `listPlugins()`,
  `marketplaceAdd/Update()`, `pluginInstall/Uninstall()`. This is where the whole-or-null
  reading of the plugin listing lives, because it is a parsing rule: a listing with one
  unreadable row returns `null`, never a shorter list.
- **Harness** (`harnesses/claude.ts`): `ensureMarketplace` and its refresh-then-retry, the
  same-name-different-repo refusal, `isAbsent` with the `SCOPE` / `OTHER_SCOPES` invariant,
  the `LOOKS_STALE` and `LOOKS_ABSENT` fallbacks. Every one of these moves verbatim with the
  claude.test case that covers it.

## File map

Where each thing in `src/` today ends up. "Verbatim" means the function body does not
change in the move; a reviewer can diff it.

| Today                                                                             | Target                                                                                                | Layer               | Note                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/cli.js`                                                                      | `bin/cli.js`                                                                                          | entry               | Requires `lib/main` instead of `lib/cli`. Contract unchanged; the CI smoke job proves it.                                                                                                                                        |
| `run.js`, `run.d.ts`                                                              | removed                                                                                               |                     | With the `./run` export and the `Profile` type.                                                                                                                                                                                  |
| `src/index.ts`                                                                    | removed                                                                                               |                     | With `main`, `types` and `exports` in package.json.                                                                                                                                                                              |
| `cli.ts` · `parseArgs`, flag tables, `parseTargets`                               | `commands/args.ts`                                                                                    | commands            | Returns `Result<ParsedArgs>` instead of throwing; the router answers 2.                                                                                                                                                          |
| `cli.ts` · `helpText`                                                             | `commands/help.ts`                                                                                    | commands            | Verbatim, minus the `bin` parameter.                                                                                                                                                                                             |
| `cli.ts` · `run` switch                                                           | `commands/router.ts` + one `commands/<cmd>.ts` each                                                   | commands            | Router: parse, configure terminal, version, brand, help, dispatch, flush, exit code.                                                                                                                                             |
| `cli.ts` · list / doctor / installed / telemetry rendering                        | `prompts/list.ts`, `doctor.ts`, `installed.ts`, `telemetry.ts`                                        | prompts             | The grid sizing, label widths and `--json` payloads move verbatim.                                                                                                                                                               |
| `cli.ts` · `gapWarnings`                                                          | `prompts/gaps.ts`                                                                                     | prompts             | Shared by installed, list and doctor prompts.                                                                                                                                                                                    |
| `cli.ts` · `telemetryCommand`                                                     | `actions/telemetry.ts` + `prompts/telemetry.ts`                                                       | actions             |                                                                                                                                                                                                                                  |
| `cli.ts` · `packageVersion`                                                       | `infrastructure/environment.ts`                                                                       | infra               |                                                                                                                                                                                                                                  |
| `install.ts` · `installPlugin`, `runInstall`                                      | `actions/install.ts`                                                                                  | actions             | See the sketch above.                                                                                                                                                                                                            |
| `install.ts` · `uninstallPlugin`, `runUninstall`                                  | `actions/uninstall.ts`                                                                                | actions             | The "record failure after printing the summary" order is kept: the report is built, the summary printed, then `failed()` returned.                                                                                               |
| `install.ts` · `updateAll`                                                        | `actions/update.ts`                                                                                   | actions             | Delegates to `InstallAction` per row with a muted `InstallPrompts` when collapsing, instead of toggling a global quiet flag.                                                                                                     |
| `install.ts` · `listPlugins`                                                      | `actions/list.ts`                                                                                     | actions             |                                                                                                                                                                                                                                  |
| `install.ts` · `decideUninstall`, `uninstallLines`                                | `application/uninstall-decision.ts`                                                                   | application         | Verbatim, with `uninstall-decision.test.ts`.                                                                                                                                                                                     |
| `install.ts` · `rowShape`                                                         | `types/installed-record.ts`                                                                           | types               | Next to `sanitizeEntry`, so the two views of a row are one module.                                                                                                                                                               |
| `install.ts` · `chooseHarnesses`, `askEach`                                       | `application/target-selection.ts` (decide) + `prompts/install.ts` (ask)                               | application         | The decision "explicit, --yes or non-interactive takes all" is pure; the asking is a prompts method.                                                                                                                             |
| `install.ts` · `assertNoMarketplaceConflict`                                      | `types/manifest-context.ts` · `conflictFor()`                                                         | types               |                                                                                                                                                                                                                                  |
| `install.ts` · manifest rebuild (`untouched`, canonical order, `foreignTargets`)  | `types/manifest-context.ts` · `recordInstall()`, `applyUninstall()`                                   | types               | The "never write a row back from the sanitized view" rule becomes the only write path.                                                                                                                                           |
| `install.ts` · `sinkOf`, `trackFailure`, `Stage`, `progress`                      | removed; `InstallReport.stage` + `types/events/`                                                      |                     |                                                                                                                                                                                                                                  |
| `install.ts` · `summarize`, `nothingChanged`                                      | `prompts/install.ts`                                                                                  | prompts             |                                                                                                                                                                                                                                  |
| `harness/index.ts`                                                                | `harnesses/index.ts` + `NAMES`, `TITLES`, `titlesOf`, `everyEditor` in `types/harness.ts`             | harnesses / types   | Static knowledge (names, titles) is types; the registry of instances is built by composition.                                                                                                                                    |
| `harness/claude.ts` · `listJson`, `listMarketplaces`, `installedPlugins`, `exec`  | `infrastructure/claude-cli.ts`                                                                        | infra               | Whole-or-null stays here.                                                                                                                                                                                                        |
| `harness/claude.ts` · policy                                                      | `harnesses/claude.ts`                                                                                 | harnesses           | Verbatim, emitting events instead of logging.                                                                                                                                                                                    |
| `harness/claude.ts`, `cursor.ts`, `vscode.ts` · every `log.*` line                | `prompts/harness/<editor>.ts`                                                                         | prompts             | 19 + 9 + 19 strings, unchanged.                                                                                                                                                                                                  |
| `harness/cursor.ts`, `vscode.ts` · file ops                                       | `harnesses/cursor.ts`, `vscode.ts` over `FileSystem` and `VsCodeSettings`                             | harnesses           |                                                                                                                                                                                                                                  |
| `catalog.ts` · `getJson`, `rawUrl`, `ghHeaders`, `loadCatalog`, `networkHint`     | `infrastructure/github-registry-client.ts`                                                            | infra               | Returns `Result<Catalog \| null>`.                                                                                                                                                                                               |
| `catalog.ts` · `normalize`, `usableEntry`                                         | `types/catalog.ts`                                                                                    | types               |                                                                                                                                                                                                                                  |
| `catalog.ts` · `entryFor`, `sourcePathFor`, `resolvePlugin`                       | `application/plugin-resolution.ts`                                                                    | application         | Takes the catalog as an argument; the session's `resolve()` fetches then calls it.                                                                                                                                               |
| `fetch.ts`                                                                        | `infrastructure/source-fetcher.ts`                                                                    | infra               | Git and API strategies behind one class. "git not found, falling back" becomes a `via: 'api'` fact the action's prompts announce; "Downloaded N files" becomes a count on the result.                                            |
| `session.ts`                                                                      | `infrastructure/session.ts`                                                                           | infra               | A memoising facade over the registry client and source fetcher, plus the Claude marketplace memo. Verbatim.                                                                                                                      |
| `manifest.ts` · `readRaw`, `write`, `upsert`, `remove`, `findRaw`                 | `infrastructure/manifest-store.ts`                                                                    | infra               | Implements the `ManifestStore` port.                                                                                                                                                                                             |
| `manifest.ts` · `sanitizeEntry`, `describeIgnored`, `foreignTargets`, `read` view | `types/installed-record.ts`, `types/manifest-context.ts`                                              | types               |                                                                                                                                                                                                                                  |
| `brand.ts` · `readRc`                                                             | `infrastructure/rc-file.ts`                                                                           | infra               | Returns `Result<RcFile \| null>`; the "loud, names the file" rule is kept as a `Failure`.                                                                                                                                        |
| `brand.ts` · `resolveBrand`, `DEFAULT_PROFILE`                                    | `application/brand-resolution.ts`, `types/brand.ts` (`DEFAULTS`, `BIN`, telemetry token and host)     | application / types | Profile removed: the token is always the project's, `defaultRepo` is a constant, `bin` is a constant.                                                                                                                            |
| `paths.ts`                                                                        | `infrastructure/paths.ts`                                                                             | infra               | Same functions, returning `DirectoryPath` / `FilePath` for the target platform.                                                                                                                                                  |
| `prompt.ts` · `createPrompter`, `parseAnswer`, `glyphs`                           | `prompts/prompter.ts`                                                                                 | prompts             | Ctrl+C resolves a `cancelled` signal instead of calling `process.exit(130)`, so session cleanup and the telemetry flush still run.                                                                                               |
| `prompt.ts` · `isCi`, `isInteractive`                                             | `infrastructure/environment.ts`                                                                       | infra               | With `unicodeSupported`, `colorEnabled` and `packageVersion`.                                                                                                                                                                    |
| `log.ts`                                                                          | `prompts/terminal.ts` (writer) + `prompts/format.ts` (`f.path`, `f.plugin`, `plural`, `wrap`, `MARK`) | prompts             | The only file allowed to call `console`.                                                                                                                                                                                         |
| `telemetry.ts` · `readState`, `writeState`                                        | `infrastructure/telemetry-state.ts`                                                                   | infra               | Fail-closed and atomic-rename rules verbatim.                                                                                                                                                                                    |
| `telemetry.ts` · the POST                                                         | `infrastructure/mixpanel-client.ts`                                                                   | infra               | The `?ip=1&verbose=1` query moves verbatim. `ip=1` is a deliberate privacy decision recorded in CLAUDE.md, not an incidental default: it lets Mixpanel derive an approximate location at ingestion. A refactor must not flip it. |
| `telemetry.ts` · `resolve`, `optOutOf`, `createTelemetry`, `describeTelemetry`    | `infrastructure/telemetry-service.ts`                                                                 | infra               | `flush()` returns `{ notice: boolean; logged: string[] }`; `prompts/router.ts` prints them. The service never prints.                                                                                                            |
| `telemetry.ts` · `EVENTS`, `COLLECTED`, `marketplaceLabel`                        | `types/events/`, `types/telemetry.ts`, `Brand.marketplaceLabel()`                                     | types               |                                                                                                                                                                                                                                  |
| `doctor.ts`                                                                       | `actions/doctor.ts` + `prompts/doctor.ts`                                                             | actions             | Checks take services from the constructor; the report shape is unchanged.                                                                                                                                                        |
| `settings-merge.ts`                                                               | `infrastructure/vscode-settings.ts`                                                                   | infra               | Verbatim.                                                                                                                                                                                                                        |
| `util.ts` · `UserError`                                                           | `types/failure.ts`                                                                                    | types               | Class stays exported as the throwable form for the migration bridge only; deleted in Phase 6.                                                                                                                                    |
| `util.ts` · validators                                                            | `types/ids/*`                                                                                         | types               |                                                                                                                                                                                                                                  |
| `util.ts` · fs helpers, `which`, `run`, `pool`, `stripBom`, `timestamp`           | `infrastructure/file-system.ts`, `process-runner.ts`                                                  | infra               | `pool` moves with the source fetcher, its only caller.                                                                                                                                                                           |
| `util.ts` · `suggest`, `editDistance`                                             | `application/plugin-resolution.ts`                                                                    | application         |                                                                                                                                                                                                                                  |
| `util.ts` · `shortPath`                                                           | `prompts/format.ts` · `f.path()`                                                                      | prompts             |                                                                                                                                                                                                                                  |
| `types.ts`                                                                        | `types/**`                                                                                            | types               | Split by owner; `Deps`, `PathOpts`, `HarnessOpts`, `Profile`, `Flags` disappear.                                                                                                                                                 |

## Test map

283 tests today. Each file follows its subject; the count column is what has to still pass
at the end of the phase that moves it. Tests that assert prose keep doing so through
`silenceConsole`; tests that only assert behaviour swap to a recording fake prompts object,
which is smaller and does not depend on wrapping.

| Today                        | Tests | Target                                                                                                                       | Moves in    | Note                                                                                                                                                                               |
| ---------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install.test.ts`            |    51 | `test/actions/install.test.ts`, `uninstall.test.ts`, `update.test.ts`, `list.test.ts`                                        | Phase 5     | The `machine()` sandbox becomes `fakeServices(machine)` in helpers. The four telemetry tests move to `test/commands/` because events are fired there now.                          |
| `cli.test.ts`                |    36 | `test/commands/args.test.ts`, `router.test.ts`, `installed.test.ts`, `telemetry.test.ts`                                     | Phase 5, 6  | `run(argv, profile)` becomes `run(argv)` in Phase 0.                                                                                                                               |
| `claude.test.ts`             |    27 | `test/harnesses/claude.test.ts` + `test/infrastructure/claude-cli.test.ts`                                                   | Phase 2c, 4 | The five listing-shape cases ("one unreadable row makes the whole listing unknown" and its siblings) test the CLI service; the rest test the harness and assert on emitted events. |
| `brand.test.ts`              |    24 | `test/application/brand-resolution.test.ts` + `test/infrastructure/rc-file.test.ts`                                          | Phase 0, 3  | Four profile cases deleted in Phase 0. Seven rc-reading cases go to infrastructure.                                                                                                |
| `settings-merge.test.ts`     |    23 | `test/infrastructure/vscode-settings.test.ts`                                                                                | Phase 2a    | Rename only.                                                                                                                                                                       |
| `catalog.test.ts`            |    20 | `test/application/plugin-resolution.test.ts` + `test/infrastructure/github-registry-client.test.ts`                          | Phase 2b, 3 | Three fetch cases (403 hint, bearer token, wrong-shaped document) go to infrastructure.                                                                                            |
| `manifest.test.ts`           |    19 | `test/infrastructure/manifest-store.test.ts` + `test/types/manifest-context.test.ts`                                         | Phase 2a, 3 | Raw read/write/upsert/remove cases stay with the store; the sanitising and gap-reporting cases go with the context.                                                                |
| `telemetry.test.ts`          |    17 | `test/infrastructure/telemetry-service.test.ts`                                                                              | Phase 2a    | Adds one assertion: the serialised payload for each event class equals today's byte for byte.                                                                                      |
| `log.test.ts`                |    12 | `test/prompts/terminal.test.ts`                                                                                              | Phase 0     | Rename only.                                                                                                                                                                       |
| `util.test.ts`               |    12 | `test/types/ids.test.ts`, `test/infrastructure/file-system.test.ts`, `process-runner.test.ts`, `test/prompts/format.test.ts` | Phase 1, 2a |                                                                                                                                                                                    |
| `doctor.test.ts`             |    10 | `test/actions/doctor.test.ts`                                                                                                | Phase 5     |                                                                                                                                                                                    |
| `paths.test.ts`              |    10 | `test/infrastructure/paths.test.ts`                                                                                          | Phase 1     | Assertions compare `toString()`; the Windows-from-Linux cases are the proof the path value objects carry the right joiner.                                                         |
| `prompt.test.ts`             |     8 | `test/prompts/prompter.test.ts` + `test/infrastructure/environment.test.ts`                                                  | Phase 2a    |                                                                                                                                                                                    |
| `session.test.ts`            |     8 | `test/infrastructure/session.test.ts`                                                                                        | Phase 2b    |                                                                                                                                                                                    |
| `fetch.test.ts`              |     4 | `test/infrastructure/source-fetcher.test.ts`                                                                                 | Phase 2b    |                                                                                                                                                                                    |
| `uninstall-decision.test.ts` |     2 | `test/application/uninstall-decision.test.ts`                                                                                | Phase 3     | Verbatim.                                                                                                                                                                          |

`scripts/test.js` lists `test/*.test.ts` flat; it gains a recursive walk in Phase 0 so
subdirectories are found on Node 18, where `--test` cannot glob.

## Phases

Eight phases, every commit a `refactor:` so nothing releases until a real change lands.
The PR count on each heading below is a size estimate now, not a branch count: every
phase lands on the one branch. Each phase names the shim it introduces to keep the old code running and
the phase that deletes it; a shim that outlives its phase is a review finding.

### Phase 0 · Kernel, guardrails, removals (1 PR, small)

- Write `types/result.ts`, `types/failure.ts`, `actions/action-result.ts`,
  `types/events/domain-event.ts` with their unit tests.
- Create the directory skeleton. Move `log.ts` to `prompts/terminal.ts`; leave `src/log.ts`
  as a one-line re-export.
- Add the eslint boundary rules (`no-restricted-imports` with per-directory `files` globs)
  scoped to the new directories, so they bite as code moves in. Turn `no-console` on with a
  single override for `prompts/terminal.ts`.
- Delete `src/index.ts`, `run.js`, `run.d.ts`; drop `main`, `types`, `exports` from
  package.json; remove `Profile` from `types.ts`, `brand.ts` and `cli.ts`.
  `run(argv, profile)` becomes `run(argv)`. `bin` becomes the constant `BIN`.
- Delete the four profile cases in `brand.test.ts`; add the recursive walk to
  `scripts/test.js`; rename `log.test.ts`.

**Exit:** suite green. `npm run build && node bin/cli.js --help` works. Shim: `src/log.ts`
re-export, deleted in Phase 7.

### Phase 1 · Value objects and the types split (1 PR, medium)

- `types/ids/`: the four identifier classes. Replace every `assertPlugin`, `assertRepo`,
  `assertRef`, `isSha`, `isPluginId` call and both `MARKETPLACE_RE` copies. Boundaries that
  receive strings (flags, env, rc, the manifest, Claude's listing) call `create()` and turn
  `undefined` into the existing failure message.
- `types/file/`: `DirectoryPath` and `FilePath` carrying a `PathRules` (`path.win32` or
  `path.posix`). `paths.ts` returns them. The 27 `path.join` sites become `join()`; the
  traversal check in the API download becomes `dest.contains(target)`.
- `prompts/format.ts` gains `f.path()`; the 24 `shortPath` sites call it. Strings unchanged.
- Split `types.ts` into `types/**` by owner. Pure mechanical; imports updated.

**Exit:** `paths.test.ts` passes unchanged apart from `.toString()`.
`grep -r 'MARKETPLACE_RE\|assertRepo' src` is empty. No shim.

### Phase 2 · Silent infrastructure (3 PRs, large)

Every service returns `Result` and never prints. The old orchestration in `install.ts`
keeps working through one temporary helper, `orThrow(result)`, which converts a `Failure`
back into a `UserError`. That helper is the bridge; Phase 5 removes its last caller.

- **2a · state and process**, in slices, because it is the largest: `file-system.ts`,
  `process-runner.ts`, `environment.ts` first, then the state files, then telemetry.
  One correction to the file map while doing it: `unicodeSupported` and `colorEnabled`
  cannot live in `environment.ts`, because `prompts/terminal.ts` reads them to build its
  glyphs and the boundary lint refuses a prompts module reaching into infrastructure.
  They stay in `prompts/terminal.ts` until Phase 6, where the router reads the
  environment and configures the terminal - which is what the target already implies.
  Original list: `file-system.ts`, `process-runner.ts`, `environment.ts`,
  `rc-file.ts`, `manifest-store.ts`, `vscode-settings.ts`, `telemetry-state.ts`,
  `mixpanel-client.ts`, `telemetry-service.ts`. The telemetry notice and the `log`-mode
  lines are returned from `flush()`, printed by the caller. This is also where the string
  arm of `DirArg` and `FileArg` was to go, so that a caller could no longer hand the
  file-system service a bare string and lose the path's own rules. **Moved to Phase 4**,
  and the reason is worth keeping: narrowing the two aliases and compiling produces 120
  errors, 106 of them in tests, and almost every production one is inside an fs module
  passing a host string to itself - `ensureDirFor` handing `path.dirname` to `ensureDir`,
  `copyDir` and `countFiles` recursing, the fetcher's temp workspace. Those strings are
  correct: an fs boundary is exactly where a path becomes a string. The leak that is
  worth closing is a different one - the source directory leaves the fetcher as a string
  and travels through the session and `HarnessContext` into the harnesses, which is why
  `cursor.ts` still calls `path.join(srcDir, ...)`. Type that as a `DirectoryPath` when
  Phase 4 rebuilds `HarnessContext` and the `deps.materialize` seam, and the arm can go
  with it. Take the
  chance to memoise the per-blob `mkdirSync` in the API download, which runs once per file
  rather than once per directory.
- **2b · network**: `github-registry-client.ts`, `source-fetcher.ts`, `session.ts`.
  Take `paths.ts` with them: it is infrastructure, and while it sits at `src/` root the
  boundary rule cannot say what `src/infrastructure` may import, so `telemetry-service.ts`
  reaching for `../paths.js` passes a rule whose message reads "nothing above it". `BIN`
  is the other such import, and Phase 3 moves it into `types/brand.ts`; once both are
  gone the rule can name the root modules and mean it. The 15
  thrown errors in `fetch.ts` and `catalog.ts` become `err(new Failure(...))` with the same
  text and hint. Correction while doing it: the fetcher's six log lines cannot become facts
  on the result. "git not found - falling back to the GitHub API" is only useful _before_
  the slow fallback it explains, and "Fetching marketplace via git ..." before the clone it
  announces; reporting either from the returned value moves it after the work, which is a
  user-visible change in a phase that promises none. They are a `SourceEvent` emitted the
  moment they happen, rendered by `prompts/source.ts` - the shape Phase 4 gives every
  harness, arriving one phase early. The registry client's one line is different and does
  ride on the result, because it describes a file already skipped; it is carried on the
  failure arm too, so a later failure cannot swallow it.
- **2c · Claude CLI**: `claude-cli.ts` with `listMarketplaces`, `listPlugins`
  (whole-or-null), `marketplaceAdd`, `marketplaceUpdate`, `pluginInstall`,
  `pluginUninstall`. `harness/claude.ts` calls it instead of `exec` directly; its policy is
  untouched.

**Exit:** `grep -rn 'log\.' src/infrastructure` is empty. Every infrastructure test runs
against a temp directory or a fake runner, none against the developer's home. Shim:
`orThrow`, deleted in Phase 5.

### Phase 3 · Application layer and the manifest context (1 PR, medium)

- Move `decideUninstall`, `uninstallLines` and their test to `application/` unchanged.
- `application/plugin-resolution.ts` takes a `Catalog | null` and returns
  `Result<ResolvedPlugin>`; the session's `resolve()` fetches then calls it. `suggest`
  moves with it.
- `application/target-selection.ts`: `resolveTargets` and the pure half of
  `chooseHarnesses`: given available, explicit, assumeYes, interactive, answer
  `'take-all' | 'ask'`.
- `application/brand-resolution.ts` over already-read rc files.
- `types/installed-record.ts`: `rowShape`, `sanitizeEntry`, `describeIgnored`,
  `foreignTargets`, the rebuild rule. `types/manifest-context.ts`: `read()`, `find()`,
  `findRaw()`, `conflictFor()`, `recordInstall()`, `applyUninstall(decision)`, over the
  `ManifestStore` port.
- Settle three things Phase 0 left behind when it removed brand profiles, all of them
  defences for a caller that no longer exists. `BrandTelemetry.token` is now never null
  in a real run, so the `no-token` opt-out and its `not configured` line in `doctor` are
  reachable from tests alone: either narrow the field to `string` and delete the branch,
  or keep both and say in the type why. The optional chaining in
  `brand.telemetry?.token` and in `marketplaceLabel`, with the test named for a Brand
  from an older caller, guards against a malformed Brand that only a cast could build.
  And `BIN` moves from `brand.ts` to `types/brand.ts`, which removes the import edge
  Phase 0 had to add from `telemetry.ts` to `brand.ts`.
- Settle one more thing when the manifest row becomes typed: a repo is compared
  case-insensitively by `RepoSlug.matches`, because that is how GitHub treats it, but
  case-sensitively with `===` by the manifest key, the marketplace conflict check and the
  `list` scope. The two halves of one run therefore disagree about whether two spellings
  name the same repository. It predates the refactor; typing the row is what makes it
  fixable in one place.

**Exit:** `grep -rn 'node:' src/application` is empty. `install.ts` no longer touches
`manifest.upsert` directly. No new shim.

### Phase 4 · Harnesses go silent (1 PR, medium)

- `types/harness.ts`: the `Harness` port, `HarnessEvent`, `HarnessListener`,
  `HarnessContext` with a `listener`, `NAMES`, `TITLES`, `titlesOf`, `everyEditor`.
- `harnesses/claude.ts`, `cursor.ts`, `vscode.ts` as classes taking their services. Every
  `log.*` becomes `ctx.listener({ kind, ... })`. `harnesses/index.ts` becomes
  `HarnessRegistry`.
- `prompts/harness/<editor>.ts`: one method per event kind, holding today's strings. The
  reload hints ("Please reload Cursor: ...") live here, keyed by editor.
- `claude.test.ts` splits; harness tests assert on the recorded events and the fake CLI's
  calls, not on console text.
- The old `install.ts` passes a listener backed by the new prompts classes, so output is
  byte-identical.

**Exit:** `grep -rn 'log\.' src/harnesses` is empty. The CI smoke job's output is
unchanged. No new shim.

### Phase 5 · Commands, actions and prompts, one command per PR (7 PRs)

Order is simplest first so the pattern is settled before the two commands that carry the
invariants. Each PR adds `actions/<cmd>.ts`, `prompts/<cmd>.ts` and `commands/<cmd>.ts`,
routes that command through them, deletes the old code path for it, and moves its tests.

- **installed** (small): manifest view, target filter, gap warnings, `--json`. The scope
  wording ("in Cursor" vs none for "all") moves to prompts.
- **telemetry** (small): status, enable, disable over the service. The precedence sentence
  ("Right now it is ...; that setting takes precedence.") moves to prompts.
- **doctor** (small): the four check groups as methods taking services; rendering and the
  `--json` payload in prompts.
- **list** (small): catalog through the session, installed marks from the manifest context;
  grid sizing (`OUTLIER_NAME`, column-major order) verbatim in prompts.
- **uninstall** (large): the marketplace-name lookup that degrades to a warning when a row
  exists, per-harness catch to `failed`, `decideUninstall`, `applyUninstall`, the summary
  lines, and only then a `failed()` return when any editor failed. The order "print
  summary, then fail" is a test.
- **install** (large): the sketch above. `chooseHarnesses` splits into the application
  decision and `InstallPrompts.askHarness()`; the prompt-flow connector (`groupEnd`) is a
  prompts concern. `InstallReport.stage` replaces the mutable `progress` object.
- **update** (medium): iterates rows, builds a per-row brand, skips rows with no detected
  editor, calls `InstallAction` with a muted prompts instance when collapsing, collects
  `InstallReport`s. Deletes `orThrow` with its last caller, and `src/install.ts` itself.

**Exit:** `src/install.ts`, `src/doctor.ts` and the rendering cases in `src/cli.ts` are
gone. Every action test constructs the action with fakes and never calls `silenceConsole`
unless it asserts prose. Shim removed: `orThrow`.

### Phase 6 · Router, composition root, telemetry events (1 PR, medium)

- `commands/router.ts`: parse (2 on failure), configure terminal, `--version` before the
  brand, brand (2 on failure), help, dispatch, flush telemetry, print the notice and
  log-mode lines through `prompts/router.ts`, exit code from the result. `src/main.ts`
  exports `run(argv)`; `bin/cli.js` requires it.
- `composition.ts` builds `Services` once: file system, runner, environment, paths, registry
  client, source fetcher, session, Claude CLI, VS Code settings, manifest context, harness
  registry, telemetry service, prompter.
- The four event classes; commands fire them from reports; `deps.track`, `sinkOf`,
  `trackFailure` and the `Deps` type are deleted. A test asserts the flushed request for
  install, failed install, uninstall and failed uninstall equals today's: both the body and
  the `?ip=1&verbose=1` query, since the query carries the location decision.
- Exit code 130 on cancel. The prompter's SIGINT handler resolves `cancelled`; nothing calls
  `process.exit` below `bin/`.
- `UserError` deleted. A thrown `Error` anywhere is a bug: stack under `--verbose`, exit 1.

**Exit:** `grep -rn 'UserError\|process\.exit' src` is empty. `cli.test.ts` is fully
migrated. `src/cli.ts` is gone.

### Phase 7 · Enforcement and documentation (1 PR, small)

- Tighten the boundary lint to cover all of `src/`; delete `src/log.ts`.
- Rewrite the Architecture section of `CLAUDE.md` around the layers. Keep every invariant
  paragraph (the `absent` / `skipped` / `failed` semantics, whole-or-null,
  never-write-from-the-sanitized-view, the telemetry rules) but file each under the layer
  that now owns it.
- Add `.claude/skills/` documents adapted from apimatic-cli's `.ai/skills` for this repo's
  shapes: `command`, `action`, `prompts`, `service`, `context`, `value-object`, `event`.
  Each with DO / DON'T, a review checklist, reference files and a scaffold.
- Rewrite the `add-harness` skill: add the name to `HarnessName` and `TITLES`, extend
  `HarnessEvent` if the editor needs a new kind, write the harness class over
  infrastructure services, write `prompts/harness/<name>.ts`, register in composition,
  tests as before. The "all output goes through log" instruction becomes "the harness emits
  events; strings live in its prompts class".
- README: remove the one sentence that mentions embedding via `run.js`, if any. Nothing else
  in the README changes.

**Exit:** `npm run lint` fails on any import that crosses a boundary. A new contributor can
scaffold a command from the skill without reading this document.

## Rules that hold for every phase

- **No user-visible string changes.** Every message moves verbatim into a prompts class. A
  string change is its own `fix:` or `feat:` commit, never part of a move, so a reviewer
  can diff a refactor PR for "moved" and nothing else.
- **Commit type is `refactor:`.** semantic-release publishes nothing until a real change
  lands. The Phase 0 removal of `run.js` and the library exports is a `refactor:` too, on
  the stated basis that nothing consumes them; if the team would rather the CHANGELOG
  record it, a `BREAKING CHANGE:` footer does that at the cost of a 1.0.0 bump.
- **Suite green at every merge, on the full matrix.** The 3 OS x 3 Node matrix and the
  smoke job are the safety net for the path value objects and the entry point.
- **Shims are named and dated.** Each phase lists the bridge it adds and the phase that
  removes it. A shim that survives its removal phase blocks the PR.
- **Verbatim means verbatim.** `decideUninstall`, the whole-or-null listing read, the JSONC
  splicer, the rc-file rules, the telemetry fail-closed rules and the path table move
  without a body change. If a move needs a body change, it is a separate commit with a test
  that motivates it.
- **Tests never touch the developer's home.** Unchanged from today; now enforced
  structurally, because every path comes from an injected `Paths` built over a sandbox.
- **Infrastructure never prints, prompts never decide.** The lint rule says it from Phase
  7; reviewers say it from Phase 0.
- **A behaviour bug found while moving code is its own commit.** Two came out of Phase 1's
  review: the home-prefix collapse in path display, fixed as a `fix:` because it changed
  what the CLI prints, and an invalid `--marketplace` reaching `claude` argv through the
  uninstall short-circuit, still open. Neither belongs inside a move.
- **Nothing enforces import order.** Six of the imports Phase 1 added landed out of
  position and were caught by review rather than by lint. Worth an `import/order` rule
  before the phases that move imports by the dozen.

## Risks and how each is held

| Risk                                                                               | Held by                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output text drifts while moving 151 log calls into prompts classes                 | Strings move verbatim; the prose-asserting tests keep `silenceConsole` through Phase 5; the smoke job diff is read on every PR.                                                                                                                                                    |
| The uninstall invariants, re-found by four review rounds, regress in a new shape   | `decideUninstall` and its state-space test move unchanged in Phase 3. The `absent` / `skipped` / `failed` contract is a type in `types/harness.ts` and the per-harness catch is a named test in the uninstall action.                                                              |
| Windows paths break under the path value objects                                   | `paths.test.ts` asserts Windows, macOS and Linux shapes from any host and is the first test to run in Phase 1. The matrix runs the real thing on Windows.                                                                                                                          |
| Telemetry schema changes by accident                                               | Property names live in event constructors; a Phase 6 test compares the flushed payload against a fixture captured from today's code.                                                                                                                                               |
| Bridge helpers (`orThrow`, the log re-export) linger and the layering never closes | Each has a named removal phase and an exit grep; Phase 7's lint makes the re-export path unimportable.                                                                                                                                                                             |
| The install PR grows until it cannot be reviewed                                   | Phases 2 to 4 take the fetch, the manifest rebuild, the harness output and the decision out of `install.ts` first, so the Phase 5 install PR is orchestration only. If it still exceeds about 600 changed lines, split `chooseHarnesses` and the source fetch into a preceding PR. |
| Two people work on adjacent phases and collide in `install.ts`                     | Phases 0 to 4 are sequential by design. Phase 5's seven PRs are independent of each other except that `update` depends on `install`.                                                                                                                                               |

## Out of scope

- Any behaviour change: new flags, new messages, new editors, a different exit code for an
  existing condition. The only visible differences at the end are exit code 130 on Ctrl+C
  and the removed `run.js`.
- Switching the test framework, adding sinon or mock-fs, or changing how CI runs.
- The open question in CLAUDE.md about `--help` and `doctor` resolving the brand before
  running. The router keeps today's order; changing it is a one-line follow-up once the
  router exists.
- Restructuring the README. It stays end-user only.
