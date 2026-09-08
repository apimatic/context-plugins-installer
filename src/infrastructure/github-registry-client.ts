import type { Catalog } from '../types/catalog.js';
import { REGISTRY_FILES, normalize } from '../types/catalog.js';
import type { Env } from '../types/env.js';
import { Failure } from '../types/failure.js';
import { GitRef } from '../types/ids/git-ref.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type { HttpPorts } from '../types/ports.js';
import { ok, err, type Result } from '../types/result.js';
import type { MarketplaceListener } from '../types/session.js';
import { isPlainObject, stripBom, errorMessage } from '../types/util.js';

export const rawUrl = (repo: string, ref: string, filePath: string): string =>
  new RepoSlug(repo).rawUrl(ref, filePath);

export function ghHeaders(env: Env = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'context-plugins-installer',
    Accept: 'application/json',
  };
  const token = env.CP_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Node's fetch ignores HTTP_PROXY/HTTPS_PROXY, so behind a proxy this fails
// where git would succeed - and the raw error is just a connect timeout.
function networkHint(env: Env = process.env): string {
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxied) {
    return 'A proxy is configured, but Node does not apply it to its own requests. Check your network, or see the docs for NODE_USE_ENV_PROXY.';
  }
  return 'Check your network connection, or whether access to github.com is blocked.';
}

// The host is what the "could not reach" line names, and a URL too malformed to
// parse would otherwise throw a TypeError from inside the handler for the
// original error, replacing it.
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A successful `null` on 404, so a missing registry is not an error. */
export async function getJson(
  url: string,
  { fetch: doFetch, env }: HttpPorts,
): Promise<Result<unknown, Failure>> {
  let text: string;
  // Reading the body belongs in here with the request: a connection that dies
  // mid-body is the same kind of problem as one that never opened, and left
  // outside this it was the one way out of a Result-returning function that was
  // still a throw.
  try {
    const res = await doFetch(url, { headers: ghHeaders(env), redirect: 'follow' });
    if (res.status === 404) return ok(null);
    if (!res.ok) {
      return err(
        new Failure(
          `GET ${url} returned ${res.status} ${res.statusText || ''}`.trim(),
          res.status === 403
            ? 'GitHub rate limit? Set GITHUB_TOKEN to raise it, or install git for the clone path.'
            : undefined,
        ),
      );
    }
    text = await res.text();
  } catch (e) {
    return err(new Failure(`Could not reach ${hostOf(url)}: ${errorMessage(e)}`, networkHint(env)));
  }
  try {
    return ok(JSON.parse(stripBom(text)) as unknown);
  } catch (e) {
    return err(new Failure(`${url} is not valid JSON: ${errorMessage(e)}`));
  }
}

export interface RegistryRequest {
  repo: string;
  ref: string;
  notify?: MarketplaceListener;
}

/**
 * The registry read, bound to its ports. `session` and every action take this
 * rather than the function, so nothing below has to carry a fetch it does not
 * use down to the one place that does.
 */
export interface RegistryClient {
  readRegistry(req: RegistryRequest): Promise<Result<Catalog | null, Failure>>;
}

const nothing: MarketplaceListener = () => {};

/** A successful `null` when the repo declares no registry at all. */
export async function readRegistry(
  { repo, ref, notify = nothing }: RegistryRequest,
  ports: HttpPorts,
): Promise<Result<Catalog | null, Failure>> {
  const slug = RepoSlug.parse(repo);
  if (!slug.ok) return err(slug.error);
  const gitRef = GitRef.parse(ref);
  if (!gitRef.ok) return err(gitRef.error);

  for (const file of REGISTRY_FILES) {
    const read = await getJson(slug.value.rawUrl(ref, file), ports);
    if (!read.ok) return err(read.error);
    if (isPlainObject(read.value)) return ok(normalize(read.value, file));
    // A 404 is the ordinary "this repo uses the other folder"; anything else
    // present but unreadable is worth a word before we move on. Said here, where
    // it happens, so a later failure cannot swallow it and a caller that reads
    // the memoised result again cannot repeat it.
    if (read.value !== null) notify({ kind: 'registry-skipped', file, repo });
  }
  return ok(null);
}

/** The client the composition root builds, and everything above it takes. */
export const registryClient = (ports: HttpPorts): RegistryClient => ({
  readRegistry: (req) => readRegistry(req, ports),
});
