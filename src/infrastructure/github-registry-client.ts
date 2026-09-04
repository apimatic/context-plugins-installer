import type { Catalog } from '../types/catalog.js';
import { REGISTRY_FILES, normalize } from '../types/catalog.js';
import type { Env } from '../types/env.js';
import { Failure } from '../types/failure.js';
import { GitRef } from '../types/ids/git-ref.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type { Deps, FetchLike } from '../types/ports.js';
import { ok, err, type Result } from '../types/result.js';
import { isPlainObject, stripBom, errorMessage } from '../util.js';

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

/** A successful `null` on 404, so a missing registry is not an error. */
export async function getJson(
  url: string,
  { env = process.env, fetchImpl = fetch }: Deps = {},
): Promise<Result<unknown, Failure>> {
  const doFetch: FetchLike = fetchImpl;
  let res;
  try {
    res = await doFetch(url, { headers: ghHeaders(env), redirect: 'follow' });
  } catch (e) {
    return err(
      new Failure(`Could not reach ${new URL(url).host}: ${errorMessage(e)}`, networkHint(env)),
    );
  }
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
  const text = await res.text();
  try {
    return ok(JSON.parse(stripBom(text)) as unknown);
  } catch (e) {
    return err(new Failure(`${url} is not valid JSON: ${errorMessage(e)}`));
  }
}

/**
 * `skipped` names the registry files that answered with something other than a
 * JSON object, and it is carried on the failure arm as well as the success one.
 * Reading it costs the caller a line either way: a file skipped before a later
 * file fails is still something the user asked to be told about with
 * `--verbose`, and a Result that only spoke on success would swallow it.
 */
export type RegistryRead = Result<Catalog | null, Failure> & {
  readonly skipped: readonly string[];
};

export interface RegistryRequest {
  repo: string;
  ref: string;
  deps?: Deps;
}

/** A successful `null` when the repo declares no registry at all. */
export async function readRegistry({
  repo,
  ref,
  deps = {},
}: RegistryRequest): Promise<RegistryRead> {
  const skipped: string[] = [];
  const slug = RepoSlug.parse(repo);
  if (!slug.ok) return { ...err(slug.error), skipped };
  const gitRef = GitRef.parse(ref);
  if (!gitRef.ok) return { ...err(gitRef.error), skipped };

  for (const file of REGISTRY_FILES) {
    const read = await getJson(slug.value.rawUrl(ref, file), deps);
    if (!read.ok) return { ...err(read.error), skipped };
    if (isPlainObject(read.value)) return { ...ok(normalize(read.value, file)), skipped };
    // A 404 is the ordinary "this repo uses the other folder"; anything else
    // present but unreadable is worth a word before we move on.
    if (read.value !== null) skipped.push(file);
  }
  return { ...ok(null), skipped };
}
