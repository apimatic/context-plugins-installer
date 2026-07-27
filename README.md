# context-plugins

Install a plugin from a plugin marketplace into every AI coding assistant on the machine —
**Claude Code**, **Cursor**, and **VS Code (Copilot)** — with one command.

```bash
npx context-plugins install discourse-api-documentation-sdk
```

Harnesses that aren't installed are skipped. Nothing is installed globally; `npx` runs the CLI
from a cache.

## Requirements

- **Node.js 18 or newer.** That's the whole list.
- `git` is optional — it makes fetching faster (sparse clone); without it the CLI falls back to
  the GitHub API.

## Commands

```bash
context-plugins install <plugin> [options]     # install into every detected harness
context-plugins uninstall <plugin> [options]   # remove it again
context-plugins update                         # refresh everything in installed.json
context-plugins list                           # what the marketplace offers
context-plugins installed                      # what this machine has
```

| Option | Default | Description |
| --- | --- | --- |
| `--repo <owner/repo>` | `context-plugins/plugin-marketplace` | Marketplace repository |
| `--ref <branch\|tag\|sha>` | `main` | Version to install from |
| `--marketplace <name>` | read from `marketplace.json` | Marketplace name |
| `--targets <list>` | all detected | `claude`, `cursor`, `vscode`, or `all` |
| `--force` | off | Replace a plugin installed from a different marketplace |
| `--json` | off | Machine-readable output for `list` / `installed` |
| `--verbose` / `--quiet` | off | More or less progress detail |

Environment equivalents: `CP_PLUGIN`, `CP_REPO`, `CP_REF`, `CP_MARKETPLACE`.
`GITHUB_TOKEN` raises the GitHub API rate limit. `CP_STATE_DIR` moves the state directory.

## What it does per harness

| Harness | Mechanism | Location |
| --- | --- | --- |
| **Claude Code** | `claude plugin marketplace add <repo>` then `claude plugin install <plugin>@<marketplace> --scope user` | Managed by Claude Code |
| **Cursor** | Copies the plugin folder into the local-plugin directory | `~/.cursor/plugins/local/<plugin>/` |
| **VS Code** | Copies the folder to the state dir and registers it in `chat.pluginLocations` | `~/.context-plugins/vscode/<plugin>/` |

After installing, reload the editor: `Ctrl+Shift+P` (`Cmd+Shift+P`) → **Developer: Reload Window**.
Claude Code picks up skills on next launch.

`settings.json` is edited as text, never reparsed, so comments and trailing commas survive — and
it is backed up to `settings.json.bak-<timestamp>` before any change.

### Where things live

```
~/.context-plugins/
  installed.json          what is installed, from which marketplace
  vscode/<plugin>/        the copy VS Code points at
```

## Whitelabel

Nothing in this package hardcodes a vendor. The marketplace name is read from the repository's
`marketplace.json`, so pointing the CLI at a different marketplace is the whole configuration:

```bash
npx context-plugins install acme-payments-sdk --repo acme/plugin-marketplace
```

To avoid typing `--repo`, commit a `.contextpluginsrc` next to the project (or in `$HOME`):

```json
{
  "repo": "acme/plugin-marketplace",
  "displayName": "Acme AI Plugins"
}
```

Resolution order, first hit wins:

```
CLI flag -> environment (CP_*) -> .contextpluginsrc (cwd, then home)
         -> brand wrapper profile -> neutral defaults
```

### Publishing a branded command

A wrapper is a package.json plus a three-line bin — not a fork. It stays current automatically
because it depends on this package by caret range.

```js
#!/usr/bin/env node
require('context-plugins/run')({
  id: 'acme',                    // marketplace name in marketplace.json
  displayName: 'Acme AI Plugins',
  repo: 'acme/plugin-marketplace',
  bin: 'acme-plugins',           // the command name printed in help text
})
```

```jsonc
{
  "name": "@acme/ai-plugins",
  "bin": { "acme-plugins": "bin/cli.js" },
  "dependencies": { "context-plugins": "^1.0.0" }
}
```

Then `npx @acme/ai-plugins install acme-payments-sdk` needs no flags. A user's own flags and
environment still override the baked profile. A complete copy-paste starting point lives in
[`examples/brand-wrapper/`](examples/brand-wrapper).

## Programmatic use

```js
const { installPlugin, resolveBrand } = require('context-plugins')

await installPlugin({
  brand: resolveBrand({ flags: { repo: 'acme/plugin-marketplace' } }),
  plugin: 'acme-payments-sdk',
  targets: ['cursor', 'vscode'],
})
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `'claude' CLI not on PATH - skipping` | Claude Code isn't installed, or its CLI isn't on `PATH`. Other harnesses still install. |
| `GitHub API request failed (403)` | Unauthenticated API limit (60/hour) with no `git` available. Install `git`, or set `GITHUB_TOKEN`. |
| `'<plugin>' is already installed from a different marketplace` | Two marketplaces ship the same plugin id. Uninstall the first, or pass `--force`. |
| `Could not determine the marketplace name` | The repo has no `.claude-plugin/marketplace.json`. Pass `--marketplace <name>`. |
| Plugin doesn't appear after install | Reload the editor window. For VS Code, check the entry in `chat.pluginLocations`. |

## Development

```bash
node --test          # 90+ unit and integration tests, zero runtime dependencies
node bin/cli.js list # run the CLI from source
```

Tests sandbox every install with `CP_STATE_DIR`, `CP_CURSOR_DIR`, and `CP_VSCODE_USER_DIR`, so
they never touch a real editor installation. The dev dependencies are release tooling only —
the published package still has none.

## Releasing

Releases are automatic and driven by commit messages. There is no manual `npm version` or
`npm publish`.

1. **Write conventional commits.** `fix:` → patch, `feat:` → minor, `feat!:` or a
   `BREAKING CHANGE:` footer → major. Anything else (`chore:`, `docs:`, `refactor:`) releases
   nothing. CI checks this on every pull request.
2. **Merge to `main`.** That starts the Release workflow.
3. **Approve the deployment.** The job waits on the `npm-publish` environment until a reviewer
   approves it — nothing reaches npm without a human click.
4. semantic-release then works out the next version, updates `CHANGELOG.md` and `package.json`,
   tags the commit, publishes to npm, and opens a GitHub release.

`main` publishes to the `latest` dist-tag. `beta` and `alpha` publish prereleases to their own
dist-tags, so `npx context-plugins` is unaffected until a change lands on `main`.

Publishing uses **npm trusted publishing (OIDC)** — the workflow authenticates with a short-lived
identity token, so there is no `NPM_TOKEN` secret to leak or rotate. The `version` field in
`package.json` reads `0.0.0-development` on purpose: the real version comes from the git tag
history at release time.

## License

MIT
