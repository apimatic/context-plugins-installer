# context-plugins

Install a plugin from a plugin marketplace into every AI coding assistant on the machine —
**Claude Code**, **Cursor**, and **VS Code (Copilot)** — with one command.

```bash
npx context-plugins install discourse-api-documentation-sdk
```

Assistants that aren't installed are skipped. Nothing is installed globally; `npx` runs the CLI
from a cache.

## Requirements

- **Node.js 18 or newer.** That's the whole list.
- `git` is optional — it makes fetching faster; without it the CLI uses the GitHub API instead.

## Commands

```bash
context-plugins install <plugin> [options]     # install into the assistants you choose
context-plugins uninstall <plugin> [options]   # remove it again
context-plugins update                         # refresh everything already installed
context-plugins list                           # what the marketplace offers
context-plugins installed                      # what this machine has
```

| Option | Default | Description |
| --- | --- | --- |
| `--repo <owner/repo>` | the bundled marketplace | Install from a different marketplace |
| `--ref <branch\|tag\|sha>` | `main` | Version to install from |
| `--marketplace <name>` | read from `marketplace.json` | Marketplace name |
| `--targets <list>` | ask | `claude`, `cursor`, `vscode`, or `all` — skips the prompt |
| `-y`, `--yes` | off | Accept every detected assistant without asking |
| `--force` | off | Replace a plugin installed from a different marketplace |
| `--json` | off | Machine-readable output for `list` / `installed` |
| `--verbose` / `--quiet` | off | More or less progress detail |

Environment equivalents: `CP_PLUGIN`, `CP_REPO`, `CP_REF`, `CP_MARKETPLACE`.
`GITHUB_TOKEN` raises the GitHub API rate limit. `CP_STATE_DIR` moves the state directory.

Defaults can also be kept in a `.contextpluginsrc` file, in the current directory or your home
directory:

```json
{ "repo": "your-org/plugin-marketplace" }
```

## Choosing where to install

`install` detects which assistants are present and asks before touching each one:

```
[Harnesses]
  ?   Install into Claude Code? [Y/n] y
  ?   Install into Cursor? [Y/n] n
  ?   Install into VS Code? [Y/n] y
```

Only the ones you accept are installed. Assistants that aren't detected are never offered, and
the plugin is downloaded *after* you answer — decline everything and nothing is fetched, written,
or recorded.

The question is skipped when the answer is already known: with `--targets`, with `-y`, during
`update` (which reuses your earlier choices), and in a non-interactive shell such as CI, where it
falls back to every detected assistant rather than waiting on input.

## What it does per assistant

| Assistant | Mechanism | Location |
| --- | --- | --- |
| **Claude Code** | `claude plugin marketplace add <repo>` then `claude plugin install <plugin>@<marketplace> --scope user` | Managed by Claude Code |
| **Cursor** | Copies the plugin folder into the local-plugin directory | `~/.cursor/plugins/local/<plugin>/` |
| **VS Code** | Copies the folder to the state directory and registers it in `chat.pluginLocations` | `~/.context-plugins/vscode/<plugin>/` |

Everything is installed for the current user, so it is available in every project you open.

After installing, reload the editor: `Ctrl+Shift+P` (`Cmd+Shift+P`) → **Developer: Reload Window**.
Claude Code picks up skills on next launch.

`settings.json` is edited as text and never reparsed, so comments and trailing commas survive —
and it is backed up to `settings.json.bak-<timestamp>` before any change.

### Where things live

```
~/.context-plugins/
  installed.json          what is installed, and from which marketplace
  vscode/<plugin>/        the copy VS Code points at
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `'claude' CLI not on PATH - skipping` | Claude Code isn't installed, or its CLI isn't on `PATH`. Other assistants still install. |
| `GitHub API request failed (403)` | Unauthenticated API limit (60/hour) with no `git` available. Install `git`, or set `GITHUB_TOKEN`. |
| `'<plugin>' is already installed from a different marketplace` | Two marketplaces ship the same plugin id. Uninstall the first, or pass `--force`. |
| `Could not determine the marketplace name` | The repository has no `.claude-plugin/marketplace.json`. Pass `--marketplace <name>`. |
| Plugin doesn't appear after install | Reload the editor window. For VS Code, check the entry in `chat.pluginLocations`. |

## License

MIT
