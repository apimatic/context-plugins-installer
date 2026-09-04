import { Failure } from '../types/failure.js';
import type { FetchLike } from '../types/ports.js';
import { err, ok, type Result } from '../types/result.js';
import { errorMessage } from '../util.js';

export interface TrackRequest {
  host: string;
  /** Already-assembled event payloads; this client adds nothing to them. */
  body: unknown[];
  fetchImpl: FetchLike;
  timeoutMs: number;
}

/**
 * One POST to Mixpanel's `/track`, bounded by a timeout it is never allowed to
 * outlive. Returns what the response said, for a caller that may want to show
 * it under `--verbose`.
 *
 * `ip=1` is a deliberate privacy decision recorded in CLAUDE.md, not an
 * incidental default: Mixpanel derives an approximate location from the request
 * address at ingestion and then discards the address, and the CLI never sends a
 * location itself. A refactor must not flip it.
 */
export async function track({
  host,
  body,
  fetchImpl,
  timeoutMs,
}: TrackRequest): Promise<Result<string, Failure>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await fetchImpl(`${host}/track?ip=1&verbose=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const said = `${res.status} ${(await res.text()).trim()}`;
    // A completed request is not a delivered event. `verbose=1` answers a
    // rejected batch with HTTP 200 and an error body, and a bad token answers
    // 401; both used to come back as ok. The text is the same either way, so
    // nothing printed changes - but a caller that branches on this now can.
    return res.ok ? ok(said) : err(new Failure(said));
  } catch (e) {
    return err(new Failure(errorMessage(e)));
  } finally {
    clearTimeout(timer);
  }
}
