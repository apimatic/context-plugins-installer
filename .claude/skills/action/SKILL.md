---
name: action
description: Add or change an action in src/actions/ - the whole flow of one CLI command, from what it was asked for to the report it answers with. Use this whenever a command needs to do something new, whenever a flow spans more than one service or harness, whenever an action is about to print directly or throw a user-facing error, and whenever an existing action's report needs another field. Not for parsing flags (see the command skill) or for words (see the prompts skill).
---

# Add an action

An action is one command's whole flow: it reads what it needs, drives the
services and harnesses, tells its own prompts class what to say, and answers
with an `ActionResult<R>`. It is the only layer allowed to reach almost
everything - and it may not import `src/commands/` or the terminal writer.

Reference by size: `installed.ts` (tiny - a read and a filter), `list.ts` (one
service, one failure), `uninstall.ts` (per-harness error handling and a pure
decision), `install.ts` and `update.ts` (the big ones).

## The shape

```ts
export interface ThingRequest {
  brand: Brand;
  /** `--targets` as written, or null for "no filter asked for". */
  targets?: readonly string[] | null;
}

export class ThingAction {
  constructor(
    private readonly prompts: ThingPrompts,
    private readonly deps: Deps = {},
    private readonly pathOpts?: PathOpts,
  ) {}

  readonly execute = async (req: ThingRequest): Promise<ActionResult<ThingReport>> => {
    const nothing: ThingReport = {/* the empty report, for the failed arms */};

    const want = resolveTargets(req.targets); // a pure decision
    if (!want.ok) return ActionResult.failed(nothing, want.error);

    const read = await someService({ deps: this.deps, notify: this.prompts.marketplaceListener });
    if (!read.ok) return ActionResult.failed(nothing, read.error);

    return ActionResult.success({/* what happened */});
  };
}
```

## DO

- **Answer with `ActionResult`**, on every path: `success`, `failed`, or
  `cancelled`. Each arm carries the report, because the command fires telemetry
  from those facts whether the run worked or not - so a report on a failed arm
  is not a formality, it is the only record of what did happen before the
  failure.
- **Build the empty report first** and hand it to every early return. That is
  what makes the failed arms carry the gaps and the counts they always did.
- **Return a `Failure`, never throw**, for anything the user can fix. The router
  prints its message and its hint and telemetry counts it as `user`. A throw
  reaching the router is a bug: stack under `--verbose`, counted `unexpected`.
- **Leave `failure` off the failed arm when the run already said everything.**
  `doctor` prints its own checks, `update` its grid - there is no sentence left
  for the router to add, and adding one would repeat the summary.
- **Speak only through `this.prompts`.** Including listeners: the marketplace
  listener is a member of the prompts class, and an action that renders nothing
  itself (because its command turns the report into a table) takes the listener
  as a required constructor argument from that command rather than importing
  one. Importing a prompts _function_ is how three actions acquired a voice they
  were not supposed to have.
- **Catch per unit of work when one failure must not hide the others.**
  `uninstall` catches per harness, records `'failed'`, finishes the run, prints
  the summary, and only then throws - and the record write is deliberately
  _not_ in a `finally`, so a write failure on the success path cannot pass
  silently.
- **Put decisions in `src/application/`** the moment they have more than one
  input. `decideUninstall` is pure over `UninstallFacts` for exactly this
  reason, and its state-space test is why that bug stopped coming back.

## DON'T

- **Don't import `src/commands/`.** Actions are called by commands, never the
  reverse. eslint refuses it.
- **Don't import `prompts/terminal.ts`.** Also refused by name.
- **Don't read flags.** The command turns argv into a request; an action takes
  values, not a command line. `--json` never reaches here.
- **Don't fire telemetry.** The command has the sink and the report.
- **Don't build the empty report inline at each return.** Two of them will
  disagree about a field.

## Tests

Two levels, and both matter:

- `test/actions/<name>.test.ts` for the flow, over the `Deps` seam and a
  sandboxed machine built from `CP_STATE_DIR` / `CP_CURSOR_DIR` /
  `CP_VSCODE_USER_DIR`, asserting on real files.
- `test/commands/<name>.test.ts` for what the command fires, with its own
  `EventSink` collecting events into an array.

`test/install-fixture.ts` holds the wrappers most install-shaped tests drive
(`installPlugin`, `uninstallPlugin`, `updateAll`), plus `machine()`. Add to it
rather than building a second sandbox.

## Review checklist

- [ ] Every path returns an `ActionResult`, and every arm carries a report.
- [ ] No throw for anything the user can fix; every `Failure` has a hint.
- [ ] `failure` is present exactly when there is a sentence left to say.
- [ ] Nothing is said except through `this.prompts`, listeners included.
- [ ] No flags, no telemetry, no `commands/` import.
- [ ] A decision with more than one input lives in `application/` and is tested there.
- [ ] Tests never touch the developer's home directory.
