import { once } from 'node:events';
import * as fs from 'node:fs';

import { LIMITS } from '../../types/archive.js';
import { Failure } from '../../types/failure.js';
import type { FilePath } from '../../types/file/paths.js';
import type { FetchResponseLike, HttpPorts } from '../../types/ports.js';
import { err, ok, type Result } from '../../types/result.js';
import type { MarketplaceListener } from '../../types/session.js';
import { errorMessage } from '../../types/util.js';
import { hostOf, isUpstreamOutage } from '../github-registry-client.js';

// Fetching an archive, which is the one request this program makes that can
// legitimately run for minutes and arrive without a length. So it is also the
// one that follows its own redirects, counts its own bytes, and gives up by
// itself.

/** Enough for a release asset's hop to an object store, and no chain worth more. */
const MAX_HOPS = 5;

const TOTAL_MS = 10 * 60 * 1000;
const IDLE_MS = 30 * 1000;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// No `Authorization`, on any hop, to any host - `ghHeaders` is deliberately not
// reused here, because attaching a token is the one thing it does. The Accept is
// everything rather than a media type, because an arbitrary host is free to
// answer a narrow one with a 406.
const HEADERS: Record<string, string> = {
  'User-Agent': 'context-plugins-installer',
  Accept: '*/*',
};

const insecureHop = (from: string, to: string): Failure =>
  new Failure(
    `${hostOf(from)} redirected to a link that is not https.`,
    `Nothing was downloaded. The redirect pointed at ${hostOf(to)}.`,
  );

const tooBig = (url: string): Failure =>
  new Failure(
    `${hostOf(url)} is sending more than ${LIMITS.bytes / (1024 * 1024)} MB.`,
    'The download was stopped. This is far larger than a plugin.',
  );

const timedOut = (url: string): Failure =>
  new Failure(
    `The download from ${hostOf(url)} stopped responding.`,
    'Check the connection and try again.',
  );

const unavailable = (url: string, status: number): Failure =>
  new Failure(
    `${hostOf(url)} is temporarily unavailable (HTTP ${status}).`,
    'Try again in a moment. If it persists, check whether a proxy is answering for it.',
  );

const unreachable = (url: string, cause: unknown): Failure =>
  new Failure(`Could not reach ${hostOf(url)}: ${errorMessage(cause)}`);

/** A redirect's own body is never read, and an unread one holds the socket open. */
function discard(res: FetchResponseLike): void {
  void res.body?.cancel?.().catch(() => undefined);
}

interface Arrival {
  url: string;
  res: FetchResponseLike;
}

async function follow(
  url: string,
  signal: AbortSignal,
  { fetch: doFetch }: HttpPorts,
): Promise<Result<Arrival, Failure>> {
  let at = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res: FetchResponseLike;
    try {
      res = await doFetch(at, { headers: HEADERS, redirect: 'manual', signal });
    } catch (e) {
      return err(signal.aborted ? timedOut(at) : unreachable(at, e));
    }
    const location = REDIRECTS.has(res.status) ? (res.headers?.get('location') ?? null) : null;
    // A response this program cannot ask about its headers is the file, the
    // same reading every other stub gets here.
    if (location === null) return ok({ url: at, res });

    discard(res);
    let next: string;
    try {
      next = new URL(location, at).toString();
    } catch {
      return err(new Failure(`${hostOf(at)} redirected to a link that could not be read.`));
    }
    if (!next.toLowerCase().startsWith('https:')) return err(insecureHop(at, next));
    at = next;
  }
  return err(new Failure(`${hostOf(url)} redirected more than ${MAX_HOPS} times.`));
}

/** Streams the body out to disk, counting, and stops the moment there is too much. */
async function drain(
  res: FetchResponseLike,
  url: string,
  to: FilePath,
  touched: () => void,
): Promise<Result<number, Failure>> {
  const body = res.body;
  if (!body) {
    // Only a stub has no body; a caller that cannot stream reads it whole.
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > LIMITS.bytes) return err(tooBig(url));
    fs.writeFileSync(to.toString(), whole);
    return ok(whole.length);
  }

  const out = fs.createWriteStream(to.toString());
  // Listened for from the start: a disk that fills between two chunks emits
  // `error` while nothing is awaiting the stream, and an unheard one ends the
  // process.
  let broken: unknown = null;
  out.on('error', (e) => {
    broken ??= e;
  });
  let seen = 0;
  try {
    for await (const chunk of body) {
      touched();
      seen += chunk.length;
      if (seen > LIMITS.bytes) {
        discard(res);
        return err(tooBig(url));
      }
      if (broken !== null) break;
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } catch (e) {
    if (broken === null) throw e;
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  if (broken !== null) return err(unwritable(to, broken));
  return ok(seen);
}

const unwritable = (to: FilePath, cause: unknown): Failure =>
  new Failure(
    `Could not write the download to ${to}: ${errorMessage(cause)}`,
    'Check the disk has room, or point CP_STATE_DIR at one that does.',
  );

export interface DownloadRequest {
  url: string;
  to: FilePath;
  notify?: MarketplaceListener;
}

export async function downloadArchive(
  { url, to, notify }: DownloadRequest,
  ports: HttpPorts,
): Promise<Result<number, Failure>> {
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const total = setTimeout(() => controller.abort(), TOTAL_MS);
  const touched = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_MS);
  };

  // Before the request, not after it: this is the line that explains the wait.
  notify?.({ kind: 'downloading', url });
  touched();
  try {
    const arrived = await follow(url, controller.signal, ports);
    if (!arrived.ok) return err(arrived.error);
    const { res } = arrived.value;

    if (!res.ok) {
      // Never read, so never left to hold the socket open.
      discard(res);
      // Its own sentence rather than the registry client's, whose hint blames an
      // outage at GitHub - and this host is whoever the user named.
      if (isUpstreamOutage(res.status)) return err(unavailable(arrived.value.url, res.status));
      return err(
        new Failure(
          `${hostOf(url)} answered ${res.status} ${res.statusText ?? ''}`.trim(),
          res.status === 404
            ? 'Check the link. A release asset URL expires with the release it belongs to.'
            : 'The link may need a login, which this tool never sends a credential for.',
        ),
      );
    }
    try {
      return await drain(res, url, to, touched);
    } catch (e) {
      return err(controller.signal.aborted ? timedOut(url) : unreachable(url, e));
    }
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}
