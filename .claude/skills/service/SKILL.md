---
name: service
description: Add or change something in src/infrastructure/ - anything that touches the file system, the network, a child process, the clock, randomness, or a file the user edits. Use this whenever new I/O is needed, whenever a service is about to print or throw (it may not do either), whenever an external CLI or HTTP response has to be parsed, and whenever a test would otherwise need the developer's real home directory.
---

# Add a service

`src/infrastructure/` is where this program touches the world. Two rules hold
across all fourteen modules and both are lint-enforced: a service **answers with
a `Result`** rather than throwing, and it **says nothing**.

Reference by shape: `rc-file.ts` (read a file the user wrote),
`manifest-store.ts` (read and write our own state), `claude-cli.ts` (drive an
external binary), `github-registry-client.ts` (HTTP + JSON boundary),
`vscode-settings.ts` (edit a file the user also edits by hand).

## The shape

```ts
import type { Failure } from '../types/failure.js';
import { err, ok, type Result } from '../types/result.js';

export function readThing(file: FilePath): Result<Thing, Failure> {
  // ... one operation, on a path the caller built.
}
```

- **Take ports, not globals.** A service that runs a command takes a
  `RunCommand`; one that fetches takes a `FetchLike`; one that reads env takes
  an `Env`. They are in `types/ports.ts`, and they exist so a test substitutes
  a fake rather than a real process or a real network.
- **Take a `DirectoryPath` or `FilePath`, not a string.** The path carries the
  target platform's rules, which is what lets `test/infrastructure/paths.test.ts`
  assert a Windows path from a Linux runner. Strings are legitimate _inside_ an
  fs module - that is where a path becomes a string - but not at its door.
- **Every new location goes through `paths.ts`,** with a `CP_*` env override
  before the default, because that override is how the test suite and the CI
  smoke job build a sandbox.

## DON'T

- **Don't print.** Not `console`, not `log`. eslint refuses the import. Whether
  anyone hears a diagnostic depends on `--verbose`, which is not a service's
  business to know. Return the line (`TelemetryLine`) or emit an event
  (`MarketplaceEvent`) and let a prompts class decide.
- **Don't throw for a problem the user can fix.** Return an `err` carrying a
  `Failure` with a message and a hint. A throw out of here is read as a bug:
  `error_kind: 'unexpected'`, a stack under `--verbose`. That is the
  distinction both values exist for.
- **Don't decide policy.** Talking to the binary is a service; what its exit
  code _means_ is the harness's. `claude-cli.ts` returns the `RunResult` for its
  command methods precisely because a non-zero exit from `claude` is evidence,
  not a failure to report - which of "stale local copy" or "no such plugin" it
  means is read from the code and the output by the caller.
- **Don't cast parsed JSON.** `isPlainObject` / `nonEmptyString` from
  `types/util.ts`, at the point the bytes become values. `as` is the
  anti-pattern this codebase is most consistent about.
- **Don't parse-and-reserialize a file the user edits.** Splice text and take a
  backup first, the way `vscode-settings.ts` does: their comments and formatting
  are not ours to normalise.

## Two conventions worth copying exactly

- **Whole-or-null for a listing that is read for absence.** `listPlugins`
  returns `null` unless _every_ row parsed, because absence is the only
  conclusion it is ever read for, and a listing whose rows this build cannot
  parse would otherwise look exactly like "nothing is installed".
  `listMarketplaces` is the opposite and filters junk rows, because one
  unreadable marketplace must not hide the rest and the worst case is re-adding
  one. Decide which of those two your reader is, and say so in a comment.
- **Fail closed on state you cannot read.** A `telemetry.json` that exists but
  will not parse disables telemetry rather than being replaced.

## Tests

`test/infrastructure/<name>.test.ts`, against a temp directory or a fake
runner, and **never** against the developer's real home. Build the sandbox from
the `CP_*` overrides. If the service drives a binary, use a recording fake and a
PATH stub so the real one is never run.

## Review checklist

- [ ] Returns a `Result`; no throw for anything a user could fix.
- [ ] Prints nothing, and `npm run lint` proves it.
- [ ] Every input that is a path is a `DirectoryPath` / `FilePath`.
- [ ] Every external value crossing in is validated, not cast.
- [ ] Policy stayed with the caller; this module only does the talking.
- [ ] A new location has a `CP_*` override and a row in `paths.test.ts` per platform.
- [ ] No test touches `$HOME`.
