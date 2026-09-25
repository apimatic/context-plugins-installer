import type { CodexEvent } from '../../types/harness.js';
import { format as f } from '../format.js';
import { log } from '../terminal.js';
import { RELOAD } from './editor.js';

/**
 * Codex's side of the conversation with its own CLI. The words follow Claude
 * Code's for the steps the two share, so a run that installs into both reads as
 * one voice; only the leftover-cache line has a path in it.
 */
export function announceCodex(event: CodexEvent, home?: string): void {
  switch (event.kind) {
    case 'cli-missing':
      log.warn("'codex' CLI not on PATH - skipping Codex.");
      return;
    case 'plugins-unsupported':
      log.warn(
        'This Codex is too old to have a `codex plugin` command - skipping Codex. Update Codex to install plugins into it.',
      );
      return;
    case 'no-marketplace-name':
      log.warn(`No marketplace name to ${event.after} from - skipping Codex.`);
      return;
    case 'marketplace-renamed':
      log.debug(`Codex knows this marketplace as '${event.known}', not '${event.configured}'.`);
      return;
    case 'marketplace-registered':
      log.info(`Marketplace '${event.known}' is already registered with Codex.`);
      return;
    case 'marketplace-upgraded':
      log.ok(`Upgraded marketplace '${event.known}'`);
      return;
    case 'marketplace-upgrade-failed':
      log.warn(
        `Could not upgrade marketplace '${event.known}' (exit ${event.code}) - continuing with the local copy. ${event.detail}`.trim(),
      );
      return;
    case 'marketplace-added':
      log.ok(`Added marketplace '${event.marketplace}'`);
      return;
    case 'plugin-stale':
      log.debug(
        `'${event.target}' is not in the local copy - upgrading '${event.known}' and retrying.`,
      );
      return;
    case 'plugin-installed':
      log.ok(`Installed ${event.target}`);
      return;
    case 'plugin-absent':
      log.info(`Codex has no '${event.target}' - nothing left to remove.`);
      return;
    case 'plugin-uninstalled':
      log.ok(`Uninstalled ${event.target}`);
      return;
    case 'plugin-uninstall-failed':
      log.warn(
        `codex plugin remove ${event.target} returned ${event.code}. ${event.detail}`.trim(),
      );
      return;
    case 'plugin-left-behind':
      log.warn(
        `codex plugin remove ${event.target} reported success, but ${f.path(event.dir, home)} is still there.`,
      );
      return;
    case 'plugin-unverified':
      log.warn(
        `Codex's listings are not answering, so whether it still holds '${event.target}' is unknown - leaving the record as it is.`,
      );
      return;
    case 'marketplace-removed':
      log.info(
        `Removed the generated marketplace '${event.known}' from Codex - it holds nothing now.`,
      );
      return;
    case 'reload':
      log.info(RELOAD.codex(event.after));
      return;
    default: {
      // A new event kind reaches here as `never`, so adding one without a line
      // for it fails to compile rather than going silently unreported.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
