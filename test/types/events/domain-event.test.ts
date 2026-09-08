import test from 'node:test';
import assert from 'node:assert';

import { DomainEvent } from '../../../src/types/events/domain-event.js';
import type { TelemetryValue } from '../../../src/types/telemetry.js';

/**
 * A stand-in, not one of the four real events - those are pinned in
 * plugin-events.test.ts. What is under test here is the base class's contract:
 * a name, flat properties, and no way to smuggle a structure through either.
 */
class TestEvent extends DomainEvent {
  readonly name = 'Context Plugin Installed';

  constructor(
    private readonly plugin: string,
    private readonly harness: string,
    private readonly durationMs: number,
  ) {
    super();
  }

  properties(): Record<string, TelemetryValue> {
    return { plugin: this.plugin, harness: this.harness, duration_ms: this.durationMs };
  }
}

test('an event names itself in the words the Mixpanel project uses', () => {
  assert.equal(new TestEvent('my-sdk', 'cursor', 12).name, 'Context Plugin Installed');
});

test('an event reports its properties under the keys the schema fixed', () => {
  assert.deepEqual(new TestEvent('my-sdk', 'cursor', 12).properties(), {
    plugin: 'my-sdk',
    harness: 'cursor',
    duration_ms: 12,
  });
});

// Flat by design: a nested value would be dropped or flattened at ingestion, and
// is the shape through which a path or an error message would escape.
test('every property is a primitive, so nothing structured can ride along', () => {
  const properties = new TestEvent('my-sdk', 'cursor', 12).properties();
  for (const [key, value] of Object.entries(properties)) {
    assert.ok(
      value === null || ['string', 'number', 'boolean'].includes(typeof value),
      `${key} is ${typeof value}, which is not a primitive`,
    );
  }
});
