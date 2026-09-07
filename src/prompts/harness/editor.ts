import {
  TITLES,
  type EditorEvent,
  type HarnessName,
  type HarnessVerb,
} from '../../types/harness.js';
import { format as f } from '../format.js';
import { log } from '../terminal.js';

// The lines every editor whose install is a directory copy says, in the same
// words for each of them. One template with the title filled in, rather than a
// copy per editor that can drift.

const reloadWindow = (harness: HarnessName): string =>
  `Please reload ${TITLES[harness]}: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window`;

/**
 * How each editor is told to pick the change up, keyed by editor so that adding
 * one without a hint does not compile. Cursor and VS Code say the same thing
 * whichever way the run went; Claude Code names the direction.
 */
export const RELOAD: Readonly<Record<HarnessName, (after: HarnessVerb) => string>> = Object.freeze({
  claude: (after: HarnessVerb) =>
    after === 'install'
      ? 'Start with `claude` or /reload-plugins to load newly added plugin.'
      : 'Restart `claude` or /reload-plugins to unload the plugin.',
  cursor: () => reloadWindow('cursor'),
  vscode: () => reloadWindow('vscode'),
});

export function announceEditor(event: EditorEvent, home?: string): void {
  switch (event.kind) {
    case 'not-installed':
      log.warn(
        `${f.path(event.root, home)} not found - ${TITLES[event.harness]} not installed, skipping.`,
      );
      return;
    case 'no-source':
      log.warn(`No plugin source was fetched - skipping ${TITLES[event.harness]}.`);
      return;
    case 'copied':
      log.ok(`Installed -> ${f.path(event.dest, home)}`);
      return;
    case 'removed':
      log.ok(`Removed -> ${f.path(event.dest, home)}`);
      return;
    case 'nothing-to-remove':
      log.info(`Nothing to remove at ${f.path(event.dest, home)}`);
      return;
    case 'reload':
      log.info(RELOAD[event.harness](event.after));
      return;
    default: {
      // A new shared kind reaches here as `never`, so adding one without a line
      // for it fails to compile rather than going silently unreported.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
