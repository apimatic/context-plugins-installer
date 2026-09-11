import type { Brand } from '../types/brand.js';
import { NAMES, everyEditor } from '../types/harness.js';

// End-user documentation of the flag table, beside the table itself, which is
// the one place the two are expected to be read together. The command name is
// a parameter rather than a literal, so a rename cannot leave a wrong example
// behind - and the editor list comes from `everyEditor`, so adding a harness
// updates the first line.

export function helpText(bin: string, brand: Pick<Brand, 'displayName' | 'label' | 'ref'>): string {
  return `
${brand.displayName} - install marketplace plugins into ${everyEditor('and')}.

Usage
  ${bin} install <plugin|path|repo> [options]
  ${bin} uninstall <plugin> [options]
  ${bin} update
  ${bin} list
  ${bin} installed
  ${bin} doctor
  ${bin} telemetry [status|enable|disable]

Install sources
  <plugin>              A plugin listed in the marketplace   (${bin} list)
  <path>                A directory that is itself a plugin - one holding
                        .claude-plugin/plugin.json. Anything starting with
                        . / ~ or a drive letter is read as a path.
  <repo>                A GitHub repository, or a folder inside one, that is
                        itself a plugin: owner/repo, owner/repo/folder, or a
                        github.com URL. An @ref after it wins over --ref.

  A plugin from a path or a repo is named by its own manifest rather than by
  the folder or the repository. Claude Code installs it through a marketplace
  this tool generates under ~/.context-plugins; ${bin} update reports such
  a plugin rather than refreshing it - re-run install to re-sync.

Options
  --repo <owner/repo>   Use a different marketplace   (default: ${brand.label})
  --ref <branch|tag|sha> Version to install from       (default: ${brand.ref})
  --marketplace <name>  Marketplace name              (default: read from the marketplace)
  --targets <list>      Comma-separated: ${NAMES.join(', ')}, all
                        install/uninstall: which editors (skips the prompt)
                        installed: list only what is recorded for them
  -y, --yes             Accept every detected harness without asking
  --force               install: replace a plugin from another marketplace
                        uninstall: drop a record nothing could confirm
  --long                Show plugin descriptions (list)
  --json                Machine-readable output (list, installed)
  --verbose             Show underlying git / CLI detail
  --quiet               Suppress progress output
  -h, --help            Show this help
  -v, --version         Show the version

Environment
  CP_PLUGIN, CP_REPO, CP_REF, CP_MARKETPLACE   Defaults for the options above
  GITHUB_TOKEN                                  Raises the GitHub API rate limit
  CP_STATE_DIR                                  Override ~/.context-plugins
  CP_TELEMETRY=off, DO_NOT_TRACK=1              Send no anonymous usage data
  CP_TELEMETRY=log                              Print it to stderr instead of sending

Examples
  ${bin} install paypal
  ${bin} install acme-payments --repo acme/plugin-marketplace
  ${bin} install paypal --targets cursor,vscode --ref v1.2.0
  ${bin} install ./my-plugin
  ${bin} install ~/dev/my-plugin --targets claude
  ${bin} install acme/my-plugin
  ${bin} install acme/monorepo/tools/my-plugin@v1.2
  ${bin} uninstall paypal
`.trimStart();
}
