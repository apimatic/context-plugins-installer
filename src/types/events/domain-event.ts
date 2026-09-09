import type { TelemetryValue } from '../telemetry.js';

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

/**
 * Where a command hands an event. The sink listens; it never takes part, so it
 * answers nothing and whatever it throws is the sink's problem and not the
 * run's - the files are already written by the time a success event is fired.
 */
export type EventSink = (event: DomainEvent) => void;
