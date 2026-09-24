import type { MarketplaceEvent } from '../types/session.js';
import { log } from './terminal.js';

/** The tail of a listing that names only some of what it counted. */
const more = ({ names, count }: { names: readonly string[]; count: number }): string =>
  count > names.length ? `, and ${count - names.length} more` : '';

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
    case 'raw-outage':
      // On stderr, because a registry read is one of the things `list --json`
      // does and a warning on stdout would land inside the payload.
      log.warnStderr(
        `${event.host} is unavailable (HTTP ${event.status}) - retrying through the GitHub API.`,
      );
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
    case 'downloading':
      log.info('Downloading the archive ...');
      log.debug(event.url);
      return;
    case 'unpacked':
      log.debug(`${event.files} files unpacked (${event.bytes} bytes)`);
      return;
    case 'entry-skipped':
      // Named rather than counted: a plugin missing a file it shipped is worth
      // knowing about, and a link is the one thing an archive carries that this
      // tool will not write.
      log.warn(
        `Skipped ${log.plural(event.count, 'link')} the archive carried: ${event.names.join(', ')}${more(event)}`,
      );
      return;
    default: {
      // A new event kind reaches here as `never`, so adding one without a line
      // for it fails to compile rather than going silently unreported.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
