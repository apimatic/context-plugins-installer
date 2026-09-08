---
name: prompts
description: Add or change anything a user reads or is asked in src/prompts/ - a message, a warning, a summary line, a table, a confirmation question, a --json payload, or the words for a new event kind. Use this whenever a string is about to be written inside an action, a service, or a harness (none of them may), whenever output formatting or glyphs change, and whenever a new command needs its own voice.
---

# Add or change what the user reads

`src/prompts/` holds every user-visible string and the only `console` in the
codebase. One class per command, plus the shared renderers: `terminal.ts` (the
writer), `format.ts` (paths and columns), `gaps.ts`, `marketplace.ts`,
`prompts/harness/` and `prompter.ts`.

It may import `types/` and other prompts modules, and nothing else. A prompts
class renders and asks; it does not decide.

## The shape

```ts
export class ThingPrompts {
  constructor(private readonly home?: string) {}

  /** The one place this command's marketplace progress becomes words. */
  readonly marketplaceListener: MarketplaceListener = announceMarketplace;

  intro(plugin: string, brand: Brand): void {
    log.banner(`Doing the thing to '${plugin}' in ${brand.label}`);
  }

  json(report: ThingReport): void {
    log.payload(JSON.stringify(report, null, 2));
  }
}
```

## DO

- **Write through `log`,** from `./terminal.js`. It is the one file the
  `no-console` rule exempts, and the only module in `prompts/` that may be
  imported by a prompts class rather than by a layer above.
- **Put a command's listener on its class.** The rule is one route: the
  marketplace listener comes from the prompts class of whoever owns the call.
  `list` and `doctor` have no class of their own inside the action, so their
  command passes its listener down as a constructor argument.
- **Use `debug` and `warnStderr` for anything a `--json` path emits** alongside
  the payload, or the payload stops being parseable. `log.notice` ignores
  `--quiet` on purpose - it is the one-time telemetry disclosure.
- **Keep glyphs built from char codes** with ASCII fallbacks for legacy Windows
  consoles, and **keep the source ASCII**, escaping anything that must not be
  normalised (`\u00a0` in `toAscii` - the port lost that one to an editor once
  already).
- **Get editor names from `everyEditor()` / `titlesOf()`,** never a literal.
  `TITLES` is a `Record<HarnessName, string>`, so an editor added without a
  title does not compile - a hand-written list just goes stale silently.
- **Shorten a path with `f.path()`.** A harness cannot reach `format.ts` (eslint
  refuses), which is why `location()` answers with a `DirectoryPath` and the
  caller formats it.
- **Say one thing per thing that happened, and nothing that did not.** The
  uninstall summary is the cautionary tale: every earlier shape of it managed to
  assert a finding that had not happened - "cleared the stale record" over a
  `--force` that confirmed nothing, "nothing was changed" over a row it had just
  shortened. No line may stand in for another.
- **Put a template where two editors share a line.** The six lines Cursor and
  VS Code both say are one template each in `prompts/harness/editor.ts` with the
  title filled in; a seventh copy is the drift `TITLES` exists to prevent.

## DON'T

- **Don't decide anything.** If a line needs a rule ("only when nothing changed
  and nothing failed"), the rule belongs in `application/` and the prompts class
  renders what it returned. `decideUninstall` exists because that logic kept
  regressing inside the printer.
- **Don't import `actions/`, `commands/`, `harnesses/`, `infrastructure/`, or
  the composition root.** eslint refuses all of them.
- **Don't change a string as part of a refactor.** A message change is its own
  `fix:` or `feat:` commit, so a reviewer can diff a refactor for "moved" and
  nothing else.
- **Don't add output to a shared renderer to serve one caller.** Give that
  caller's class the line.

## Tests

- `test/prompts/harness.test.ts` and `test/prompts/marketplace.test.ts` are the
  tables where the words are pinned: one row per event kind, keyed so a missing
  row does not compile, asserting the message **and** its level (`ok` / `info` /
  `warn` / `debug`). Record at `log`, not at the console - the glyph, the
  wrapping and whether `debug` shows at all are `terminal.ts`'s and have their
  own tests.
- `test/prompts/terminal.test.ts` covers the writer itself; `format.test.ts` the
  path shortening; `prompter.test.ts` the question flow, including that Ctrl-C
  comes back as `'cancelled'` rather than exiting.

## Review checklist

- [ ] Every new string is in `src/prompts/`, and `npm run lint` proves nothing else prints.
- [ ] No decision was made here that a pure function could make.
- [ ] Editor names come from `everyEditor()` / `titlesOf()`.
- [ ] Anything emitted next to a `--json` payload uses `debug` / `warnStderr`.
- [ ] A new event kind has its row in the prompts table test, with the right level.
- [ ] No line claims something that might not have happened.
- [ ] The source file is still ASCII.
