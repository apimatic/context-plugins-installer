---
name: command
description: Add or change a CLI command in src/commands/ - a new subcommand, a new flag, a change to the router's dispatch order or exit codes, or the telemetry events a command fires. Use this whenever the user wants the CLI to accept something new, whenever argv parsing or `--help` text changes, and whenever a run's exit code or its Mixpanel events need to change. Not for the flow itself (see the action skill).
---

# Add a command

A command is the thin layer between argv and an action: it parses flags, calls
one action, turns that action's report into telemetry events, and hands the
result back to the router for an exit code. It may import `types/`, `actions/`
and `prompts/` - **not** `infrastructure/`, and not the terminal writer.

Reference: `commands/list.ts` (the smallest), `commands/install.ts` (the one
with real event logic), `commands/args.ts` (the flag table),
`commands/router.ts` (dispatch and exit codes).

## Steps

1. **Add the flag or verb to `commands/args.ts`.** It is a typed flag table -
   no oclif, no clack, by decision - and `parseArgs` answers with a
   `Result<ParsedArgs, Failure>`, so an unreadable command line becomes exit 2
   rather than a throw. If the new flag is target-aware, add it to
   `TARGET_AWARE` so `--targets` is not silently ignored.

2. **Write `src/commands/<cmd>.ts`.**

   ```ts
   export class ThingCommand {
     constructor(
       private readonly sink: EventSink,
       private readonly prompts = new ThingPrompts(),
     ) {}

     async run(args: ThingArgs): Promise<ActionResult<ThingReport>> {
       const action = new ThingAction(this.prompts.marketplaceListener, args.deps, args.pathOpts);
       try {
         const result = await action.execute(args);
         if (args.json) this.prompts.json(result.report);
         else this.prompts.render(result.report);
         if (result.isFailed()) this.sink(new ThingFailedEvent(/* facts */, 'user'));
         return result;
       } catch (err) {
         // A throw from here is a bug, not the user's to fix. Both facts come
         // off the action, because there is no report to read.
         this.sink(new ThingFailedEvent(/* facts */, 'unexpected'));
         throw err;
       }
     }
   }
   ```

3. **Add the case to `router.ts`.** The order there is a decision, not an
   accident of where the code sat: parse, configure the terminal from
   `--verbose` / `--quiet`, `--version` (which must answer even when the rc file
   beside it is broken), the brand, `--help`, then dispatch, and a `finally`
   that flushes telemetry so a whole `update` is one request. A command needing
   a service takes it from `Services` - a port in `types/` - because
   `commands/` may not import `infrastructure/` at all.

4. **Add the lines to `commands/help.ts`.** Editor names in prose come from
   `everyEditor()` / `titlesOf()`; never hand-write a list.

5. **README**, if the flag is user-facing: the **Options** table, and the
   detection paragraph if it changes where things land.

## DO

- **Fire events from the report, on every arm.** Success and failure both, which
  is why an `ActionResult` carries a report even when it failed.
- **Distinguish `user` from `unexpected` honestly.** A `Failure` on the failed
  arm is `user`; the `catch` is `unexpected`. Getting this backwards makes a
  released build's error counts meaningless - and it has happened twice in this
  codebase, both times by turning a returned failure into a throw.
- **Render through a prompts class.** `--json` output goes to `log.payload`, and
  anything alongside it uses `debug` / `warnStderr` so the payload stays
  parseable.
- **Let the router own the exit code.** 0, 1, 130 from the arm; exit 2 is the
  router's own for a command line - or an rc file - it could not read.

## DON'T

- **Don't import `infrastructure/`.** This is the rule that forces the
  composition root to exist. If you need a service, add a member to `Services`
  in `types/services.ts` and build it in `src/composition/`.
- **Don't import `prompts/terminal.ts`.** Speak through a prompts class.
- **Don't put flow here.** If the command grows a second `await` over a service,
  that belongs in the action.
- **Don't let a sink failure matter.** It cannot: the composition root wraps it,
  so a throwing sink cannot fail a run that has already written its files.

## Tests

- `test/commands/<cmd>.test.ts` - drive the command with its own `EventSink` and
  assert the events, including the failure arms.
- `test/commands/router.test.ts` - argv in, exit code out, and the dispatch
  order. Its `NAMES`-driven expectations list every editor.
- `test/telemetry.test.ts` pins one whole flushed request, key order included.

## Review checklist

- [ ] `parseArgs` covers the new flag, and `TARGET_AWARE` if it is target-aware.
- [ ] Events fire on the success arm _and_ the failed arm _and_ the `catch`.
- [ ] `user` vs `unexpected` matches which way the failure travelled.
- [ ] No `infrastructure/` import, no terminal import (`npm run lint`).
- [ ] Help text updated; every editor list comes from `everyEditor()`.
- [ ] Exit code comes off the `ActionResult`, not from a `process.exit`.
