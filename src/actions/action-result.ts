import type { Failure } from '../types/failure.js';

type Outcome = 'success' | 'failed' | 'cancelled';

// 130 is the shell's convention for a process ended by SIGINT. A usage error
// exits 2, but that never reaches an action: the router answers it.
const EXIT_CODES = { success: 0, failed: 1, cancelled: 130 } as const;

/**
 * What an action hands back. Every variant carries the run's report, not just
 * the successful one, because the command fires telemetry from those facts
 * whether the run worked or not.
 */
export class ActionResult<R> {
  private constructor(
    private readonly outcome: Outcome,
    readonly report: R,
    readonly failure: Failure | null,
  ) {}

  static success<R>(report: R): ActionResult<R> {
    return new ActionResult('success', report, null);
  }

  /**
   * `failure` is optional because a run can fail having already said everything
   * it has to say: `doctor` prints its own checks and its own summary, and there
   * is no one sentence left for the caller to add. Anything else passes one.
   */
  static failed<R>(report: R, failure: Failure | null = null): ActionResult<R> {
    return new ActionResult('failed', report, failure);
  }

  static cancelled<R>(report: R): ActionResult<R> {
    return new ActionResult('cancelled', report, null);
  }

  isSuccess(): boolean {
    return this.outcome === 'success';
  }

  isFailed(): boolean {
    return this.outcome === 'failed';
  }

  isCancelled(): boolean {
    return this.outcome === 'cancelled';
  }

  exitCode(): (typeof EXIT_CODES)[Outcome] {
    return EXIT_CODES[this.outcome];
  }
}
