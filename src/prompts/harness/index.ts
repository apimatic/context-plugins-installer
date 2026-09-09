import type { HarnessEvent, HarnessListener } from '../../types/harness.js';
import { announceClaude } from './claude.js';
import { announceCursor } from './cursor.js';
import { announceVscode } from './vscode.js';

// The strings the harnesses used to print themselves. Each editor's own lines
// live in its own file; the six that every copying editor says in the same
// words are in editor.ts. Nothing here imports a harness, and no harness
// imports this: the caller wires one into the other for the length of a call.

export function announceHarness(event: HarnessEvent, home?: string): void {
  switch (event.harness) {
    case 'claude':
      announceClaude(event);
      return;
    case 'cursor':
      announceCursor(event, home);
      return;
    case 'vscode':
      announceVscode(event, home);
      return;
    default: {
      // A new editor reaches here as `never`, so one added without any lines of
      // its own fails to compile rather than installing in silence.
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/** A listener for one run, bound to the home directory its paths are shown against. */
export const harnessListener =
  (home?: string): HarnessListener =>
  (event) =>
    announceHarness(event, home);
