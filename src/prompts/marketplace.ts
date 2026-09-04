import type { MarketplaceEvent } from '../types/session.js';
import { log } from './terminal.js';

/**
 * The strings the registry client and the source fetcher used to print
 * themselves, one case per event. This is the shape Phase 4 gives every harness:
 * infrastructure reports what happened, and the words for it live here.
 */
export function announceMarketplace(event: MarketplaceEvent): void {
  switch (event.kind) {
    case 'registry-skipped':
      log.debug(`${event.file} in ${event.repo} is not a JSON object - skipping it.`);
      return;
    case 'no-git':
      log.warn(
        'git not found - falling back to the GitHub API (60 requests/hour unauthenticated).',
      );
      return;
    case 'cloning':
      log.info('Fetching marketplace via git ...');
      log.debug(`${event.url} (${event.ref})`);
      return;
    case 'checked-out':
      log.debug(`${event.files} files checked out`);
      return;
    case 'tree-truncated':
      log.warn('GitHub tree response was truncated; some files may be missing. Prefer git.');
      return;
    case 'downloaded':
      log.info(`Downloaded ${event.files} files via the GitHub API.`);
      return;
    default: {
      // A new event kind reaches here as `never`, so adding one without a line
      // for it fails to compile rather than going silently unreported.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
