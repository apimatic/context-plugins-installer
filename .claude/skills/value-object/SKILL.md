---
name: value-object
description: Add or change a value object in src/types/ - an identifier (plugin id, repo slug, git ref, marketplace name), a path, or any string this program validates once and then trusts. Use this whenever a raw string is being validated in more than one place, whenever a regex is about to be written next to a `typeof x === 'string'` check, whenever an `as` cast appears on parsed JSON, and whenever two spellings of the same thing need to compare equal. Also use it when reviewing code that takes a `string` where it means an id.
---

# Add a value object

A value object is a string this program has already decided is valid, plus the
rules about it. It exists so that validation happens once, at the edge, and
nothing downstream re-checks or re-decides. `src/types/ids/plugin-id.ts` is the
smallest complete example; `src/types/ids/repo-slug.ts` is the one that carries
a comparison rule; `src/types/file/paths.ts` is the one that carries behaviour.

## The shape

```ts
import { Failure } from '../failure.js';
import { err, ok, type Result } from '../result.js';

// Why this is validated at all: interpolated into a URL, passed as argv, read
// from a file someone else wrote. One sentence, not a paragraph.
const PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_LENGTH = 64;

export class Thing {
  /** For callers holding an already-validated value; anything else uses `parse`. */
  constructor(private readonly value: string) {}

  static parse(value: unknown): Result<Thing, Failure> {
    if (typeof value !== 'string' || !PATTERN.test(value) || value.length > MAX_LENGTH) {
      return err(new Failure(`Invalid thing: ${JSON.stringify(value)}`, 'Expected ...'));
    }
    return ok(new Thing(value));
  }

  /** undefined rather than a reason, for callers that only need to know. */
  static create(value: unknown): Thing | undefined {
    const parsed = Thing.parse(value);
    return parsed.ok ? parsed.value : undefined;
  }

  isEqual(other: Thing): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
```

## DO

- **Take `unknown` in `parse`.** The point of the type is that it stands where
  the input has not been checked. `parse(value: string)` pushes the `typeof`
  check back out to every caller, which is where it was before.
- **Return `Result<T, Failure>` from `parse`, with the user's sentence in the
  `Failure`.** The message and hint are what the router prints, so write them
  for the person who typed the flag, not for a log.
- **Keep `create()` for callers that only need yes-or-no.** A manifest row this
  build cannot read is dropped, not explained.
- **Put a comparison rule on the type**, as a static if callers hold raw
  strings. `RepoSlug.same(a, b)` is case-insensitive because that is how GitHub
  reads a slug, and it is a static precisely because the manifest key, the
  marketplace conflict check and `list`'s scope all compare strings they never
  parsed. Two halves of one run disagreeing about whether `Acme/M` and `acme/m`
  name the same repository was a real bug with a real cost: a second row for a
  plugin already installed, which neither spelling could then uninstall.
- **Give it `toString()`** and let callers interpolate.

## DON'T

- **Don't validate the same string twice.** If a function takes a `PluginId` it
  may not re-check the pattern. If you want to, the id got in unvalidated
  somewhere else and that is the bug.
- **Don't add a getter returning the raw string** for anything but display.
  `toString()` is the display route; a `.raw` invites argv built around the type.
- **Don't put I/O anywhere near it.** `src/types/` is barred from every node
  builtin by eslint, `node:crypto` included - a value that mints a UUID is not
  a value that can be tested twice.
- **Don't reach for a branded type alias.** These are classes on purpose: a
  brand is erased at runtime and cannot carry `same()` or a pattern.
- **Don't let one grow a second responsibility.** `MarketplaceLabel` answers
  what telemetry may say about a marketplace and nothing else, which is why it
  has a private constructor and one static.

## Tests

`test/types/ids/*.test.ts`, one file per type. Assert the accepted shapes, the
rejected ones with their message, and any comparison rule **directly** - a
comparison covered only through a caller is one that gets reasoned about from
the caller's behaviour next time it changes.

## Review checklist

- [ ] `parse` takes `unknown`, and every boundary that receives a raw value calls it.
- [ ] The `Failure` names the bad value and the hint says what was expected.
- [ ] No caller re-validates: a grep for the pattern finds it in one file.
- [ ] Any equality that is not `===` lives on the type, and every site uses it.
- [ ] `npm run lint` passes, so `src/types/` still reaches nothing above it.
