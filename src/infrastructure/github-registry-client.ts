import { BIN } from '../types/brand.js';
import type { Catalog } from '../types/catalog.js';
import { REGISTRY_FILES, normalize } from '../types/catalog.js';
import type { Env } from '../types/env.js';
import { Failure } from '../types/failure.js';
import { GitRef } from '../types/ids/git-ref.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import { MANIFEST_FILES, readManifest, type PluginManifest } from '../types/plugin-manifest.js';
import type { FetchResponseLike, HttpPorts, RegistryClient } from '../types/ports.js';
import { ok, err, type Result } from '../types/result.js';
import type { MarketplaceListener } from '../types/session.js';
import { isPlainObject, stripBom, errorMessage } from '../types/util.js';

export const rawUrl = (repo: string, ref: string, filePath: string): string =>
  new RepoSlug(repo).rawUrl(ref, filePath);

/** What the API's contents endpoint answers with the file itself rather than a JSON envelope of it. */
export const RAW_MEDIA_TYPE = 'application/vnd.github.raw';

export function ghHeaders(
  env: Env = process.env,
  accept = 'application/json',
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'context-plugins-installer',
    Accept: accept,
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
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Anything 500 and up is the far end failing, not this run - so every one of
 * them says the same sentence. The response itself is not repeated: a status
 * line, or the Varnish error page a CDN puts in front of one, tells the user
 * nothing they can act on and reads as though their marketplace, their token or
 * their network were at fault. The code is kept because it is the one part of
 * the response worth putting in a bug report; nothing else of it is shown.
 */
export const isUpstreamOutage = (status: number): boolean => status >= 500;

export const upstreamFailure = (url: string, status: number): Failure =>
  new Failure(
    `${hostOf(url)} is temporarily unavailable (HTTP ${status}).`,
    // "Usually", not "is": a status is the only evidence here, and a proxy, a
    // captive portal or an enterprise mirror that cannot reach upstream answers
    // 502 of its own. Telling that user their setup is fine is the one way this
    // sentence can be actively wrong, so it points at the other possibility
    // instead of ruling it out.
    `Usually an outage at GitHub rather than a problem with your setup - try again in a moment. If it persists, check whether a proxy is answering for ${hostOf(url)}.`,
  );

/** One sentence for every way a request can fail to arrive at all. */
const unreachable = (url: string, cause: unknown, env: Env): Failure =>
  new Failure(`Could not reach ${hostOf(url)}: ${errorMessage(cause)}`, networkHint(env));

const nothing: MarketplaceListener = () => {};

export interface RepoFileRequest {
  repo: RepoSlug;
  ref: string;
  filePath: string;
  notify?: MarketplaceListener;
}

/**
 * Whether a response is carrying JSON *about* a file rather than the file. Asked
 * with `RAW_MEDIA_TYPE` the contents endpoint answers
 * `application/vnd.github.raw`; asked with anything else it answers
 * `application/json` with an envelope whose `content` is base64 - and whose
 * `name` is the file's own name, which `normalize` would read as a marketplace
 * called `marketplace.json` with no plugins in it, and which `downloadPath`
 * would write over a plugin file byte for byte. The header is the only honest
 * way to tell those apart, so a response that cannot be asked counts as the
 * file: only a stub omits it.
 *
 * Anchored on `application/json` rather than a search for "json", because
 * `application/vnd.github.raw+json` is a spelling of the raw media type itself.
 */
const carriesJson = (res: FetchResponseLike): boolean =>
  /^application\/json\b/i.test(res.headers?.get('content-type') ?? '');

/** The response worth reading, and the URL it came from, so a caller names the host it got. */
export interface RepoFileResponse {
  url: string;
  res: FetchResponseLike;
}

/**
 * One file out of a repository, over both hosts that can serve it: the raw CDN
 * first, and the API's contents endpoint when the CDN answers with an outage.
 * The two are separate services, so a 503 from `raw.githubusercontent.com` -
 * which this tool sees often enough to have a message for it - is usually the
 * CDN's alone and the same bytes are a request away. No token is needed for
 * either; one is sent when the environment has it, because the anonymous API
 * budget is 60 requests an hour.
 *
 * Only an outage falls back. A 404 is the answer to the question (the registry
 * read asks two folders and expects one of them to be missing), a 403 is a
 * rate limit and a 401 a bad token - asking a second host cannot improve any of
 * those, and the second answer would replace a message the user can act on.
 *
 * The body is left to the caller, because the two of them want different things
 * from it - text to parse, bytes to write - and reading it here would mean two
 * shapes of the same function.
 */
export async function fetchRepoFile(
  { repo, ref, filePath, notify = nothing }: RepoFileRequest,
  { fetch: doFetch, env }: HttpPorts,
): Promise<Result<RepoFileResponse, Failure>> {
  const url = repo.rawUrl(ref, filePath);
  let res: FetchResponseLike;
  try {
    res = await doFetch(url, { headers: ghHeaders(env), redirect: 'follow' });
  } catch (e) {
    return err(unreachable(url, e, env));
  }
  if (!isUpstreamOutage(res.status)) return ok({ url, res });

  // Before the second request, not after it: the wait is what the line explains.
  notify({ kind: 'raw-outage', host: hostOf(url), status: res.status });
  const apiUrl = repo.contentsUrl(ref, filePath);
  try {
    const api = await doFetch(apiUrl, {
      headers: ghHeaders(env, RAW_MEDIA_TYPE),
      redirect: 'follow',
    });
    // Only a success carrying the file replaces the CDN's answer. A fallback
    // that fails has recovered nothing, and the outage is the better diagnosis
    // of the two: a 404 from the API here would report a file that exists as
    // missing, and every other status is about the host we only asked because
    // the first one was down. An envelope is refused rather than decoded for
    // the same reason - a proxy that rewrites `Accept` is how one arrives, and
    // "try again in a moment" is the right answer to that, where reading it as
    // the file would be silently wrong.
    if (api.ok && !carriesJson(api)) return ok({ url: apiUrl, res: api });
  } catch {
    /* Both hosts unreachable is still the outage the first one reported. */
  }
  return ok({ url, res });
}

/** A successful `null` on 404, so a missing registry is not an error. */
async function getJson(req: RepoFileRequest, ports: HttpPorts): Promise<Result<unknown, Failure>> {
  const got = await fetchRepoFile(req, ports);
  if (!got.ok) return err(got.error);
  const { url, res } = got.value;

  if (res.status === 404) return ok(null);
  if (isUpstreamOutage(res.status)) return err(upstreamFailure(url, res.status));
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

  let text: string;
  // Reading the body is guarded like the request that carried it: a connection
  // that dies mid-body is the same kind of problem as one that never opened,
  // and left unguarded it was the one way out of a Result-returning function
  // that was still a throw.
  try {
    text = await res.text();
  } catch (e) {
    return err(unreachable(url, e, ports.env));
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
    const read = await getJson({ repo: slug.value, ref, filePath: file, notify }, ports);
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

export interface PluginManifestRequest {
  repo: string;
  ref: string;
  /** A folder inside the repository, or null for the repository itself. */
  path: string | null;
  notify?: MarketplaceListener;
}

async function isMarketplace(
  slug: RepoSlug,
  ref: string,
  notify: MarketplaceListener,
  ports: HttpPorts,
): Promise<boolean> {
  for (const file of REGISTRY_FILES) {
    const read = await getJson({ repo: slug, ref, filePath: file, notify }, ports);
    if (read.ok && isPlainObject(read.value)) return true;
  }
  return false;
}

export async function readPluginManifest(
  { repo, ref, path, notify = nothing }: PluginManifestRequest,
  ports: HttpPorts,
): Promise<Result<PluginManifest, Failure>> {
  const slug = RepoSlug.parse(repo);
  if (!slug.ok) return err(slug.error);
  const gitRef = GitRef.parse(ref);
  if (!gitRef.ok) return err(gitRef.error);

  const prefix = path === null ? '' : `${path}/`;
  const where = path === null ? `${repo}@${ref}` : `'${path}' in ${repo}@${ref}`;

  let problem: Failure | null = null;
  for (const file of MANIFEST_FILES) {
    const read = await getJson({ repo: slug.value, ref, filePath: prefix + file, notify }, ports);
    if (!read.ok) return err(read.error);
    if (read.value === null) continue;
    const manifest = readManifest(read.value, `${prefix}${file} in ${repo}@${ref}`);
    if (manifest.ok) return ok(manifest.value);
    problem ??= manifest.error;
  }
  if (problem) return err(problem);

  if (await isMarketplace(slug.value, ref, notify, ports)) {
    return err(
      new Failure(
        `${where} has no plugin manifest, but ${repo} is a marketplace.`,
        `Install one of its plugins with \`${BIN} install <plugin> --repo ${repo}\`, or see what it offers with \`${BIN} list --repo ${repo}\`.`,
      ),
    );
  }
  return err(
    new Failure(
      `${where} does not look like a plugin.`,
      `No plugin manifest there. Looked for ${MANIFEST_FILES.join(', ')}.`,
    ),
  );
}

/** The client the composition root builds, and everything above it takes. */
export const registryClient = (ports: HttpPorts): RegistryClient => ({
  readRegistry: (req) => readRegistry(req, ports),
  readPluginManifest: (req) => readPluginManifest(req, ports),
});
