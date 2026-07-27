# Brand wrapper example

A complete whitelabel front door for `context-plugins`. Two files, no forking.

```
package.json    name, bin name, and a caret dependency on context-plugins
bin/cli.js      three lines: hand a brand profile to the shared implementation
```

## Make it yours

1. Copy this folder.
2. In `package.json`: set `name` to your scope (`@yourco/…`) and `bin` to the command you want
   users to type.
3. In `bin/cli.js`: set `id` (your marketplace's `name` in `marketplace.json`), `repo`,
   `displayName`, and `bin` (matching step 2).
4. `npm publish --access public`.

Your users then run:

```bash
npx @yourco/ai-plugins install your-first-sdk
```

No flags, and no other vendor's name in the command.

## Why a caret dependency

`"context-plugins": "^0.1.0"` means fixes and new harness support reach your users without you
republishing. The wrapper only ever carries your branding.

## Precedence

Your profile is a *default*, not a lock. Anyone can still override it:

```
CLI flag -> CP_* environment -> .contextpluginsrc -> your profile -> neutral defaults
```

That's deliberate: a developer working against a staging marketplace can point your command at it
with `--repo`, without you shipping a second package.
