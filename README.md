# context-plugins

Install a plugin from a plugin marketplace into every AI coding assistant on the machine —
**Claude Code**, **Cursor**, and **VS Code (Copilot)** — with one command.

```bash
npx context-plugins install <plugin>
```

For example, to install the PayPal SDK plugin:

```bash
npx context-plugins install paypal
```

`npx context-plugins list` shows every plugin the marketplace offers. Assistants that aren't
installed are skipped. Nothing is installed globally; `npx` runs the CLI from a cache.

## Requirements

- **Node.js 18 or newer** — the only requirement for the CLI itself.
- **At least one assistant.** Each has its own prerequisite: Claude Code needs the `claude` CLI on
  `PATH`, Cursor needs `~/.cursor`, VS Code needs its user directory. Missing ones are skipped, so
  an install succeeds as long as one is present.
- `git` is optional — it makes fetching faster; without it the CLI uses the GitHub API instead.

## Commands

```bash
context-plugins install <plugin> [options]     # install into the assistants you choose
context-plugins uninstall <plugin> [options]   # remove it again
context-plugins update                         # refresh everything already installed
context-plugins list                           # what the marketplace offers
context-plugins installed                      # what this machine has
context-plugins doctor                         # check this machine can install
context-plugins telemetry [status|enable|disable]   # anonymous usage data, see below
```

## Options

| Option                     | Default                      | Description                                                 |
| -------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `--repo <owner/repo>`      | the bundled marketplace      | Install from a different marketplace                        |
| `--ref <branch\|tag\|sha>` | `main`                       | Version to install from                                     |
| `--marketplace <name>`     | read from `marketplace.json` | Marketplace name                                            |
| `--targets <list>`         | ask                          | `claude`, `cursor`, `vscode`, or `all` — skips the prompt   |
| `-y`, `--yes`              | off                          | Accept every detected assistant without asking              |
| `--force`                  | off                          | Replace a plugin installed from a different marketplace     |
| `--long`                   | off                          | Show plugin descriptions in `list`                          |
| `--json`                   | off                          | Machine-readable output for `list` / `installed` / `doctor` |
| `--verbose` / `--quiet`    | off                          | More or less progress detail                                |
| `-h`, `--help`             | —                            | Show usage and exit                                         |
| `-v`, `--version`          | —                            | Print the version and exit                                  |

With `--json`, stdout carries the payload and nothing else — warnings and `--verbose` detail go
to stderr, so `... --json | jq` is safe to script against. The commands that read `installed.json` show only what
this version understands: anything in it they cannot read — a whole entry, or a single target of
one — is named in a warning and left on disk for the version that owns it.

Environment equivalents: `CP_PLUGIN`, `CP_REPO`, `CP_REF`, `CP_MARKETPLACE`.
`GITHUB_TOKEN` raises the GitHub API rate limit. `CP_STATE_DIR` moves the state directory.
`CP_TELEMETRY=off` or `DO_NOT_TRACK=1` turns off [usage data](#telemetry).

Defaults can also be kept in a `.contextpluginsrc` file, in the current directory or your home
directory:

```json
{ "repo": "your-org/plugin-marketplace", "telemetry": false }
```

## Choosing where to install

`install` looks for each assistant and asks before touching the ones it finds:

```
[Harnesses]
  ?   Install into Claude Code? [Y/n] y
  ?   Install into Cursor? [Y/n] n
  ?   Install into VS Code? [Y/n] y
```

Only the ones you accept are installed. Assistants that aren't detected are never offered, and
the plugin is downloaded _after_ you answer — decline everything and nothing is fetched, written,
or recorded.

Detection is a directory check, not a true install check: Claude Code is found by looking for the
`claude` CLI on `PATH`, but Cursor and VS Code are found by the presence of their user directories.
A leftover directory from an uninstalled editor still counts as present, and an editor that has
never been launched may not be found yet.

The question is skipped when the answer is already known: with `--targets`, with `-y`, during
`update` (which reuses your earlier choices), and in a non-interactive shell such as CI, where it
falls back to every detected assistant rather than waiting on input.

## What it does per assistant

| Assistant       | Mechanism                                                                                                                   | Location                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Claude Code** | Adds the marketplace, or updates it if you already had it, then `claude plugin install <plugin>@<marketplace> --scope user` | Managed by Claude Code                |
| **Cursor**      | Copies the plugin folder into the local-plugin directory                                                                    | `~/.cursor/plugins/local/<plugin>/`   |
| **VS Code**     | Copies the folder to the state directory and registers it in `chat.pluginLocations`                                         | `~/.context-plugins/vscode/<plugin>/` |

Everything is installed for the current user, so it is available in every project you open.

After installing, reload the editor: `Ctrl+Shift+P` (`Cmd+Shift+P`) → **Developer: Reload Window**.
In Claude Code, run `/reload-plugins` to load the plugin without restarting — or start a new
`claude` session.

`settings.json` is edited as text and never reparsed, so comments and trailing commas survive —
and it is backed up to `settings.json.bak-<timestamp>` before any change. If the file is shaped in
a way the edit cannot safely splice into, the install says so and prints the one line to paste,
rather than reporting a change it did not make.

### Where things live

```
~/.context-plugins/
  installed.json          what is installed, and from which marketplace
  telemetry.json          a random machine id and your telemetry choice
  vscode/<plugin>/        the copy VS Code points at
```

## Telemetry

When `install`, `update`, or `uninstall` finishes, the CLI sends one anonymous event per plugin
and editor, so the marketplace maintainers can see which plugins people use and where. Each event
carries:

- the plugin id and the editor it went into; for a failure, the step it failed at and whether that
  was a usage error or a crash, never the message
- the marketplace, only when it is the built-in one; any `--repo` you pass is reported as `custom`
- the command (`install`, `update`, or `uninstall`), whether the editors were named with
  `--targets`, how long the install took, and whether the run was interactive or in CI
- OS, CPU architecture, Node major version, and CLI version
- a random id for this machine, kept in `~/.context-plugins/telemetry.json`

Each request also carries the Mixpanel project token, a public routing key that says which
project the events belong to. It never includes file paths, usernames, hostnames, IP-derived
location, error messages, environment variables, or anything from the plugin itself. A notice is
printed on stderr the first time anything is sent.

Turn it off in any of these ways; the first that applies wins:

```bash
export DO_NOT_TRACK=1                        # the cross-tool convention
export CP_TELEMETRY=off                      # this CLI only
echo '{ "telemetry": false }' > ~/.contextpluginsrc
npx context-plugins telemetry disable        # remembered in telemetry.json
```

`context-plugins telemetry status` shows what is in effect. `CP_TELEMETRY=log` prints every event
to stderr instead of sending it, so you can see exactly what would leave the machine.

## Something not working?

`doctor` checks everything an install depends on and says which part is unhappy:

```
$ npx context-plugins doctor
# example output from Linux - versions, paths, and counts will differ on your machine

Environment
  ✓   Node.js          v20.11.0
  ✓   git              git version 2.43.0

Editors
  ✓   Claude Code      claude on PATH
  ✓   Cursor           ~/.cursor
  !   VS Code          not installed (looked in ~/.config/Code/User)

Marketplace
  ✓   Reachable        raw.githubusercontent.com
  ✓   Registry         context-plugins, 29 plugins
  ✓   API budget       59 of 60 requests left

Local state
  ✓   State directory  ~/.context-plugins (writable)
  ✓   Installed        2 plugins
  ✓   Telemetry        enabled
```

The VS Code path on that last `Editors` line is platform-specific:

| Platform | VS Code user directory                                  |
| -------- | ------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Code/User`               |
| Linux    | `~/.config/Code/User` (or `$XDG_CONFIG_HOME/Code/User`) |
| Windows  | `%APPDATA%\Code\User`                                   |

`✓` fine, `!` works but worth knowing, `x` blocks an install. It exits non-zero
only when something blocks, so it can be used in a script; add `--json` for machine-readable
output.
The live plugin list and count are at [the Context Plugins directory](https://hub.contextplugins-hub.pages.dev/), or run `npx context-plugins list`.

## Troubleshooting

| Symptom                                                                   | Cause / fix                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `'claude' CLI not on PATH - skipping`                                     | Claude Code isn't installed, or its CLI isn't on `PATH`. Other assistants still install.                                        |
| `GitHub API request failed (403)`                                         | Unauthenticated API limit (60/hour) with no `git` available. Install `git`, or set `GITHUB_TOKEN`.                              |
| `'<plugin>' is already installed from a different marketplace`            | Two marketplaces ship the same plugin id. Uninstall the first, or pass `--force`.                                               |
| `Could not determine the marketplace name`                                | The repository has no `.claude-plugin/marketplace.json`. Pass `--marketplace <name>`.                                           |
| `Claude Code already has a marketplace named '<name>', from <other-repo>` | An unrelated marketplace occupies that name. Remove it with `claude plugin marketplace remove <name>`, then re-run.             |
| `'<plugin>' is not listed in <marketplace>`                               | Wrong id, or the plugin was renamed upstream — the message suggests the closest match, and `list` shows them all.               |
| A plugin fails during `update`                                            | Usually a plugin renamed upstream, so the recorded id no longer exists: `uninstall <old-id>`, then `install <new-id>`.          |
| Plugin doesn't appear after install                                       | Reload the editor window. For VS Code, check the entry in `chat.pluginLocations`.                                               |
| `Could not edit <settings.json> - add this entry yourself`                | The file has no JSON object to splice into. Paste the printed line into `settings.json`; the plugin files are already in place. |

## License

MIT
