---
name: event
description: Add or change an event in this codebase - a telemetry DomainEvent in src/types/events/, a HarnessEvent an editor emits, or a MarketplaceEvent from the registry client or source fetcher. Use this whenever something needs reporting to Mixpanel, whenever a service or harness wants to print progress (it may not - it emits), whenever a new property should ride on an existing event, and whenever a line has to appear before slow work rather than after it.
---

# Add an event

Three kinds, answering to different rules. Pick the right one first.

| Kind               | Declared in        | For                                         | Rendered by              |
| ------------------ | ------------------ | ------------------------------------------- | ------------------------ |
| `DomainEvent`      | `types/events/`    | telemetry: one fact per thing that happened | nobody - it is sent      |
| `HarnessEvent`     | `types/harness.ts` | what one editor's install or uninstall did  | `prompts/harness/`       |
| `MarketplaceEvent` | `types/session.ts` | registry reads, clones, API downloads       | `prompts/marketplace.ts` |

## A telemetry event

Reference: `src/types/events/plugin-installed.ts`, and
`plugin-install-failed.ts` for the failure shape.

```ts
export class PluginThingHappenedEvent extends DomainEvent {
  readonly name = 'Context Plugin Thing Happened'; // title case - Mixpanel's own

  constructor(
    private readonly plugin: PluginId,
    private readonly harness: HarnessName,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return { plugin: this.plugin.toString(), harness: this.harness };
  }
}
```

- **The constructor's parameter types are the privacy control.** Take a
  `PluginId`, a `HarnessName`, a `MarketplaceLabel`, a boolean, a number. A
  bare `string` parameter is how a path, a hostname or an error message gets in,
  so if you want one, ask whether a value object should exist instead.
- **`properties()` is the Mixpanel contract**: snake_case, flat, primitives
  only, declared once. Nothing else in the codebase may spell those names.
- **Never a `--repo` the user typed.** `MarketplaceLabel.of(brand)` answers with
  the built-in constant or `custom`, and that is the only marketplace value
  allowed to leave the machine - a differently cased spelling of the built-in
  marketplace counts as the built-in one, and the spelling stays home.
- **Run-level facts belong to the sender** - command, CLI and Node version, OS,
  arch, CI, interactive, run id. Do not add them to an event.
- **Keep `COLLECTED` in `types/telemetry.ts` in step.** It is the one prose
  inventory the first-run notice and `telemetry status` print. A property
  collected but not described there is exactly what that rule exists to stop.
- **A command fires it.** `src/commands/<cmd>.ts` has the report and the sink;
  an action does not, and a service must never.
- **A failure event carries a stage and an `error_kind`, never a message.**
  `user` for a `Failure` an action returned, `unexpected` for a throw. If a new
  failure path reads as `unexpected` when a user could have fixed it, the fix is
  in the code that threw, not in the event.

Test in `test/types/events/plugin-events.test.ts`: construct it, assert `name`
and the exact `properties()` object. `test/telemetry.test.ts` pins one whole
flushed request including key order - if you change what a command fires, that
is the test that tells you the payload moved.

## A harness or marketplace event

These exist so infrastructure and harnesses can stay silent while the line still
appears exactly where it always did.

- **Emit facts, never sentences.** A path, an exit code, a file count, the tail
  of some output. The words live in the matching prompts module, so that the
  strings a user reads have one place they can be changed from.
- **Emit at the moment it happens, not from what a function returns.** Two real
  bugs are behind this. "git not found - falling back to the GitHub API" is only
  useful _before_ the slow fallback it explains. And a line reported from a
  memoised result is said once per caller rather than once per run: three
  plugins from one repo announced the same clone three times, because the
  session caches the promise and every plugin reads that cache. Emitted inside
  the cached promise, the words happen as often as the work.
- **Add the type to the union and the case to the renderer.** Both renderers end
  in a `never` default, so a new kind without a line fails to compile rather
  than going silently unreported.
- **Then add its row to the prompts test** - where the words are pinned, level
  (`ok` / `info` / `warn` / `debug`) included. `test/prompts/marketplace.test.ts`
  keys its table by `MarketplaceEvent['kind']`, so a new marketplace kind with
  no row does not compile. `test/prompts/harness.test.ts` cannot do that - a
  `HarnessEvent` is discriminated by editor and kind together - so it is an
  array plus a runtime check that every editor says something, which will
  **not** notice a new kind added to an editor that already has rows. On that
  side the row is yours to remember.

## Review checklist

- [ ] Right kind: sent to Mixpanel, or said to the user?
- [ ] No parameter can carry a path, username, env var, error message, or user-supplied repo.
- [ ] `properties()` is flat, snake_case, primitives only - and `COLLECTED` names every one.
- [ ] A telemetry event is constructed in `src/commands/`, nowhere below it.
- [ ] A said event is emitted at the moment of the work, inside whatever memo caches it.
- [ ] The renderer's `never` default still compiles, and the prompts test has its row.
- [ ] `test/telemetry.test.ts` still passes, or its fixture was updated deliberately.
