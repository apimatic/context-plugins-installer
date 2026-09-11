import type { ClaudeEvent } from '../../types/harness.js';
import { log } from '../terminal.js';
import { RELOAD } from './editor.js';

/**
 * Claude Code's side of the conversation with its own CLI. Nothing here has a
 * path in it, so unlike the copying editors none of these lines needs a home
 * directory to be read against.
 */
export function announceClaude(event: ClaudeEvent): void {
  switch (event.kind) {
    case 'cli-missing':
      log.warn("'claude' CLI not on PATH - skipping Claude Code.");
      return;
    case 'no-marketplace-name':
      log.warn(`No marketplace name to ${event.after} from - skipping Claude Code.`);
      return;
    case 'marketplace-renamed':
      log.debug(`Claude knows this marketplace as '${event.known}', not '${event.configured}'.`);
      return;
    case 'marketplace-registered':
      log.info(`Marketplace '${event.known}' is already registered - updating it.`);
      return;
    case 'marketplace-updated':
      log.ok(`Updated marketplace '${event.known}'`);
      return;
    case 'marketplace-update-failed':
      log.warn(
        `Could not update marketplace '${event.known}' (exit ${event.code}) - continuing with the local copy. ${event.detail}`.trim(),
      );
      return;
    case 'marketplace-added':
      log.ok(`Added marketplace '${event.marketplace}'`);
      return;
    case 'marketplace-add-rejected':
      log.debug(`marketplace add returned ${event.code} (likely already added). ${event.detail}`);
      return;
    case 'plugin-stale':
      log.debug(
        `'${event.target}' is not in the local copy - refreshing '${event.known}' and retrying.`,
      );
      return;
    case 'plugin-installed':
      log.ok(`Installed ${event.target} (${event.scope} scope)`);
      return;
    case 'plugin-absent':
      log.info(
        `Claude Code has no '${event.plugin}' at ${event.scope} scope - nothing left to remove.`,
      );
      return;
    case 'plugin-uninstalled':
      log.ok(`Uninstalled ${event.target}`);
      return;
    case 'marketplace-removed':
      log.info(`Removed the generated marketplace '${event.known}' - it holds nothing now.`);
      return;
    case 'staging-left':
      // The failure names the directory, which is why this line does not have
      // to - and why nothing here needs a home to read a path against.
      log.warn(`${event.detail} You can remove that directory by hand.`);
      return;
    case 'plugin-uninstall-failed':
      log.warn(
        `claude plugin uninstall ${event.target} returned ${event.code}. ${event.detail}`.trim(),
      );
      return;
    case 'reload':
      log.info(RELOAD.claude(event.after));
      return;
    default: {
      // A new event kind reaches here as `never`, so adding one without a line
      // for it fails to compile rather than going silently unreported.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
