import { Failure } from '../failure.js';
import { err, ok, type Result } from '../result.js';

// A plugin id is interpolated into URLs and passed as argv, so it is validated
// where it enters rather than trusted from a flag, an env var, or the manifest.
const PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_LENGTH = 64;

export class PluginId {
  /** For callers holding an already-validated id; anything else uses `parse`. */
  constructor(private readonly id: string) {}

  static parse(value: unknown): Result<PluginId, Failure> {
    if (typeof value !== 'string' || !PATTERN.test(value) || value.length > MAX_LENGTH) {
      return err(
        new Failure(
          `Invalid plugin id: ${JSON.stringify(value)}`,
          'Expected kebab-case, e.g. acme-payments',
        ),
      );
    }
    return ok(new PluginId(value));
  }

  /** undefined rather than a reason, for callers that only need to know. */
  static create(value: unknown): PluginId | undefined {
    const parsed = PluginId.parse(value);
    return parsed.ok ? parsed.value : undefined;
  }

  isEqual(other: PluginId): boolean {
    return this.id === other.id;
  }

  toString(): string {
    return this.id;
  }
}
