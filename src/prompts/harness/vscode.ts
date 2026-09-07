import type { VscodeEvent } from '../../types/harness.js';
import { KEY, toKey } from '../../types/vscode-settings.js';
import { format as f } from '../format.js';
import { log } from '../terminal.js';
import { announceEditor } from './editor.js';

/**
 * What only VS Code says. Most of it is about settings.json, and the two lines
 * that ask the user to write the entry themselves spell it exactly as the
 * splice would have.
 */
export function announceVscode(event: VscodeEvent, home?: string): void {
  switch (event.kind) {
    case 'unregistered-only':
      log.ok(`Nothing was at ${f.path(event.dest, home)} - unregistered it`);
      return;
    case 'settings-failed':
      log.warn(`Could not edit ${f.path(event.settings, home)} - add this entry yourself:`);
      log.info(`"${KEY}": { "${toKey(event.dest)}": true }`);
      return;
    case 'settings-conflict':
      // "Already registered" here would be a green install of a plugin that
      // never loads, and a second entry would leave a duplicate key.
      log.warn(
        `${f.path(event.settings, home)} already names this path, but not as an entry that loads it.`,
      );
      log.info(`Make it read "${toKey(event.dest)}": true`);
      return;
    case 'settings-already':
      log.info(`Already registered in ${f.path(event.settings, home)}`);
      return;
    case 'settings-registered':
      log.info(`Registered in chat.pluginLocations (${f.path(event.settings, home)})`);
      return;
    case 'settings-unregistered':
      log.info(`Unregistered from chat.pluginLocations (${f.path(event.settings, home)})`);
      return;
    case 'settings-unremovable':
      log.warn(
        `${f.path(event.settings, home)} names ${f.path(event.dest, home)} in a form this tool did not write.`,
      );
      log.info('Remove that entry by hand - nothing here can take it out safely.');
      return;
    case 'settings-backed-up':
      log.debug(`Backed up settings.json -> ${event.backup.name()}`);
      return;
    default:
      // Everything left is a shared kind. A VS Code-only kind added without a
      // case above arrives here and is refused by the shared renderer's type.
      announceEditor(event, home);
  }
}
