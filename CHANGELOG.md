# Changelog

## 0.1.0 (unreleased)

First release.

- `install`, `uninstall`, `update`, `list`, `installed` commands.
- Installs into Claude Code (native CLI), Cursor (`~/.cursor/plugins/local`), and VS Code
  (copy + `chat.pluginLocations`); undetected harnesses are skipped.
- Fetches plugin folders via git sparse-clone, falling back to the GitHub API when `git` is absent.
- Marketplace name is derived from the repository's `marketplace.json` rather than hardcoded, so
  the CLI carries no vendor branding.
- Brand profiles resolve flag -> env -> `.contextpluginsrc` -> wrapper profile -> neutral default;
  wrapper packages inject a profile via `require('context-plugins/run')`.
- `installed.json` entries are keyed by repo + plugin, so two marketplaces can ship the same
  plugin id without evicting each other.
- Zero runtime dependencies; Node 18+.
