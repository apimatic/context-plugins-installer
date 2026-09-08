---
name: context
description: Add or change a context in src/types/ - a domain object over a port (ManifestContext over ManifestStore) or a bundle of facts passed down a call (HarnessContext, PathOpts, HarnessOpts). Use this whenever rules about a file or a record are drifting apart from the code that reads it, whenever a read-then-write pair could be got wrong by a caller, and whenever a function is growing a fifth positional argument that all its callers pass through.
---

# Add a context

Two shapes share the name, and both live in `src/types/`.

**A domain object over a port** - `ManifestContext` over the `ManifestStore`
port - is the file as operations rather than bytes. It holds every rule about
the data and knows nothing about where the data lives.

**A call context** - `HarnessContext`, `PathOpts`, `HarnessOpts` - is the facts
one operation needs, bundled so that adding a fact does not change every
signature between the top and the bottom.

## A domain object over a port

```ts
export class ThingContext {
  /** `now` is required: a clock default here would put nondeterminism in types/. */
  constructor(
    private readonly store: ThingStore,
    private readonly now: () => string,
  ) {}

  /** Every lookup and every write goes through one private read. */
  private rowFor(key: Key): Record<string, unknown> | null {
    /* ... */
  }

  read(): View {
    /* sanitized, plus what it could not show */
  }
  record(fact: Fact): void {
    /* rebuilds from the raw row */
  }
}
```

- **The port goes in `types/ports.ts`;** the implementation goes in
  `src/infrastructure/`. `manifest-store.ts` is the bytes (read whole, written
  through a rename), `installed-record.ts` is the rules about a row, and
  `ManifestContext` is the object over both. Keep that three-way split.
- **Make the pairing that can be got wrong into one method.** The rule here is
  _never write a row back from the sanitized read view_ - a field or target name
  belonging to a newer CLI has to survive a rewrite - and it stopped being
  possible to get wrong when reading the raw row and rebuilding it moved
  _inside_ the two methods that own the write. That is the whole technique: if a
  caller must do A then B, give them one method that does both.
- **Route every lookup and both writes through one private read.** Folding the
  repo's case meant one key can match more than one row (a manifest an older
  build wrote can hold two spellings), so `upsert` and `remove` act on _every_
  matching row while a naive `find` returned the first. Read one and write
  several and another row's targets leave with nothing naming them.
- **Have `read()` answer with what it could not show,** not just what it could:
  `ignored` (rows dropped, with reasons) and `elided` (rows listed without a
  target name this build knows). Every command that renders the view says what
  it left out - that is what `prompts/gaps.ts` is for.
- **No clock, no randomness, no I/O.** Take `now` as a parameter. `src/types/`
  is barred from `node:crypto` for the same reason.

## A call context

```ts
export interface ThingContext {
  plugin: string;
  /** Where the harness says what it did. Required: a dropped line is a bug. */
  listener: ThingListener;
  /** Where the files are, for the shape that copies. */
  srcDir?: DirectoryPath | null;
}
```

- **Type the paths.** `srcDir` is a `DirectoryPath`, typed all the way from the
  fetcher, so a harness needs no path arithmetic of its own and cannot reach for
  `node:path`.
- **Make the listener required.** An optional listener is a line that can go
  missing without anything failing.
- **Optional means "genuinely absent", not "usually passed".** `session` is
  optional because a lone install has no shared session; `marketplace` is
  `string | null` because an unresolved name is a real state with real
  behaviour, not a missing argument.
- **Don't add a field only one caller reads.** Two fields on `InstallRequest`
  are read by the command and ignored by the action, which is harmless while
  both callers pass the same values twice and a trap the moment one does not.

## Tests

`test/types/manifest-context.test.ts` is the model: drive the context against a
fake store and assert the rules - including that a write rebuilt the raw row, and
that a key matching two rows writes both. `test/application/uninstall-decision.test.ts`
shows the other half: when the rules become a decision, walk the whole state
space rather than a handful of cases.

## Review checklist

- [ ] The port is in `types/ports.ts`; only `src/infrastructure/` implements it.
- [ ] No I/O, no clock, no randomness inside the context.
- [ ] Any read-then-write pairing a caller could get wrong is one method.
- [ ] Every lookup and every write goes through the same private read.
- [ ] `read()` reports what it dropped as well as what it kept.
- [ ] A call context's paths are path types, and its listener is required.
- [ ] No field is on the context for a caller that does not read it.
