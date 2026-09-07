import type { CursorEvent } from '../../types/harness.js';
import { log } from '../terminal.js';
import { announceEditor } from './editor.js';

/** What only Cursor says; everything else is a line both copying editors share. */
export function announceCursor(event: CursorEvent, home?: string): void {
  if (event.kind === 'no-plugin-json') {
    log.warn(
      'Plugin has no .cursor-plugin/plugin.json - Cursor may not list it. Installing anyway.',
    );
    return;
  }
  // Everything left is a shared kind. A Cursor-only kind added without a branch
  // above arrives here and is refused by the shared renderer's type.
  announceEditor(event, home);
}
