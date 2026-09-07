import { Failure } from '../types/failure.js';
import { NAMES, isHarnessName, type HarnessName } from '../types/harness.js';
import { err, ok, type Result } from '../types/result.js';

// Which editors a run is about. Two decisions, both pure: what `--targets`
// asked for, and whether the run may ask the user about the rest.

/** Nothing asked for, or `all`, reads as every editor - in canonical order. */
export function resolveTargets(
  requested?: readonly string[] | null,
): Result<HarnessName[], Failure> {
  if (!requested || requested.length === 0 || requested.includes('all')) return ok([...NAMES]);
  const unknown = requested.filter((t) => !isHarnessName(t));
  if (unknown.length) {
    return err(
      new Failure(
        `Unknown target(s): ${unknown.join(', ')}`,
        `Valid targets: ${NAMES.join(', ')}, all`,
      ),
    );
  }
  return ok(NAMES.filter((n) => requested.includes(n)));
}

/**
 * `cannot-ask` is `take-all` with something to say about it: there was nobody to
 * ask, which is worth a line, where an explicit `--targets` or `--yes` is the
 * user having already answered.
 */
export type TargetChoice = 'take-all' | 'ask' | 'cannot-ask';

export interface ChooseTargetsFacts {
  /** How many detected editors are on the table; none leaves nothing to ask about. */
  detected: number;
  /** `--targets` named them, so the choice is already made. */
  explicit: boolean;
  /** `--yes` opted out of being asked. */
  assumeYes: boolean;
  /** Whether there is anyone to answer: an injected confirm, or a real terminal. */
  canAsk: boolean;
}

export function chooseTargets({
  detected,
  explicit,
  assumeYes,
  canAsk,
}: ChooseTargetsFacts): TargetChoice {
  if (!detected || explicit || assumeYes) return 'take-all';
  return canAsk ? 'ask' : 'cannot-ask';
}
