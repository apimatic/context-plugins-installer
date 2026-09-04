import type { SourceEvent } from '../types/session.js';
import { log } from './terminal.js';

/**
 * The strings the source fetcher used to print itself, one case per event. This
 * is the shape Phase 4 gives every harness: infrastructure reports what
 * happened, and the words for it live here.
 */
export function announceSource(event: SourceEvent): void {
  switch (event.kind) {
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
  }
}
