import type { TelemetryValue } from '../../types.js';

/**
 * Something that already happened, named in the past tense.
 *
 * The property names are a Mixpanel contract, so each subclass declares them in
 * one place, behind a constructor whose parameter types cannot admit a path, an
 * error message, or a nested object. Run-level facts (command, versions, CI) are
 * the sender's to add, not an event's.
 */
export abstract class DomainEvent {
  /** The Mixpanel event name, in the title case that project uses. */
  abstract readonly name: string;

  /** Flat, primitive-only facts about what happened. */
  abstract properties(): Record<string, TelemetryValue>;
}
