import { log } from './log.js';
import type { Catalog, CatalogPluginEntry, Deps, Env, FetchLike, ResolvedPlugin } from './types.js';
import {
  UserError,
  assertRepo,
  assertRef,
  stripBom,
  suggest,
  isPlainObject,
  nonEmptyString,
  errorMessage,
} from './util.js';

// Claude Code and Cursor read the same registry shape from different folders.
// We prefer the Claude one and fall back to Cursor's.
export const REGISTRY_FILES = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
];

// Claude Code's marketplace schema: kebab-case identifier, no spaces.
const MARKETPLACE_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

export const rawUrl = (repo: string, ref: string, filePath: string): string =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`;

export function ghHeaders(env: Env = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'context-plugins-installer',
    Accept: 'application/json',
  };
  const token = env.CP_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Node's built-in fetch ignores HTTP_PROXY / HTTPS_PROXY, so on a network that
 * requires a proxy this fails even though `git` - which does read the proxy
 * settings - would succeed. Worth saying, because the raw error is just a
 * connect timeout.
 */
function networkHint(env: Env = process.env): string {
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxied) {
    return 'A proxy is configured, but Node does not apply it to its own requests. Check your network, or see the docs for NODE_USE_ENV_PROXY.';
  }
  return 'Check your network connection, or whether access to github.com is blocked.';
}

/** GET JSON, returning null for 404 so a missing registry is not an error. */
export async function getJson(
  url: string,
  { env = process.env, fetchImpl = fetch }: Deps = {},
): Promise<unknown> {
  const doFetch: FetchLike = fetchImpl;
  let res;
  try {
    res = await doFetch(url, { headers: ghHeaders(env), redirect: 'follow' });
  } catch (err) {
    throw new UserError(`Could not reach ${new URL(url).host}: ${errorMessage(err)}`, {
      hint: networkHint(env),
    });
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new UserError(`GET ${url} returned ${res.status} ${res.statusText || ''}`.trim(), {
      hint:
        res.status === 403
          ? 'GitHub rate limit? Set GITHUB_TOKEN to raise it, or install git for the clone path.'
          : undefined,
    });
  }
  const text = await res.text();
  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (err) {
    throw new UserError(`${url} is not valid JSON: ${errorMessage(err)}`);
  }
}

/**
 * A registry entry is usable when it can produce a plugin id: the bare-string
 * form, or an object with a string name. Anything else - null, a number, an
 * object with no name - is dropped here, where the registry is read, instead
 * of crashing whichever consumer reaches `p.name` first (`list` did).
 */
const usableEntry = (p: unknown): p is CatalogPluginEntry =>
  nonEmptyString(p) || (isPlainObject(p) && nonEmptyString(p.name));

export function normalize(data: Record<string, unknown>, from: string): Catalog {
  const declared: unknown[] = Array.isArray(data.plugins) ? data.plugins : [];
  const plugins = declared.filter(usableEntry);
  return {
    marketplace: nonEmptyString(data.name) ? data.name : null,
    plugins,
    // How many declared entries were unusable. Kept so resolve can tell "the
    // registry lists nothing" apart from "it lists things we cannot read".
    dropped: declared.length - plugins.length,
    from,
  };
}

export interface LoadCatalogOptions {
  repo: string;
  ref: string;
  deps?: Deps;
}

/** Load a repo's marketplace registry. Returns null when the repo has none. */
export async function loadCatalog({ repo, ref, deps = {} }: LoadCatalogOptions) {
  assertRepo(repo);
  assertRef(ref);
  for (const file of REGISTRY_FILES) {
    const data = await getJson(rawUrl(repo, ref, file), deps);
    // A wrong-shaped document (a bare array, a string) is no registry at all:
    // fall through to the next file rather than answer with an empty catalog.
    if (isPlainObject(data)) return normalize(data, file);
    if (data !== null) log.debug(`${file} in ${repo} is not a JSON object - skipping it.`);
  }
  return null;
}

const nameOf = (p: CatalogPluginEntry): string => (typeof p === 'string' ? p : p.name);

export const entryFor = (
  catalog: Catalog | null,
  plugin: string,
): CatalogPluginEntry | undefined =>
  catalog ? catalog.plugins.find((p) => nameOf(p) === plugin) : undefined;

/** `./plugins/foo` and `plugins/foo` both normalize to the repo-relative `plugins/foo`. */
export function sourcePathFor(entry: CatalogPluginEntry | undefined, plugin: string): string {
  const source: unknown = entry && typeof entry === 'object' ? entry.source : undefined;
  if (typeof source === 'string' && source.trim()) {
    const rel = source.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel && !rel.includes('..')) return rel;
  }
  if (isPlainObject(source)) {
    const kind = nonEmptyString(source.source) ? source.source : 'object';
    throw new UserError(
      `Plugin '${plugin}' is hosted in another repository (source type '${kind}').`,
      { hint: 'Point --repo at the repository that actually contains the plugin folder.' },
    );
  }
  return `plugins/${plugin}`;
}

export interface ResolvePluginOptions {
  repo: string;
  ref: string;
  plugin: string;
  /** Overrides the registry's name. */
  marketplace?: string | null;
  /** What the user sees in place of the repository. */
  label?: string;
  deps?: Deps;
  /** A registry already loaded by the session; `null` means the repo has none. */
  catalog?: Catalog | null;
}

/**
 * Resolve everything the installers need for one plugin:
 * the marketplace name (derived unless overridden) and the folder inside the repo.
 */
export async function resolvePlugin({
  repo,
  ref,
  plugin,
  marketplace = null,
  label,
  deps = {},
  catalog: preloaded,
}: ResolvePluginOptions): Promise<ResolvedPlugin> {
  // `label` is what the user sees; the repository stays an internal detail.
  const shown = label || `${repo}@${ref}`;
  // `undefined` means nobody supplied one; `null` is a valid answer meaning the
  // repository has no registry, so it must not trigger a second fetch.
  const catalog = preloaded === undefined ? await loadCatalog({ repo, ref, deps }) : preloaded;
  const entry = entryFor(catalog, plugin);

  // Fire when the registry declared entries, even if none were usable -
  // otherwise a registry of nameless entries reads as "no list published" and
  // a typo'd id walks past this into prompts, marketplace registration, and a
  // late "plugin folder is empty or missing" failure.
  if (catalog && (catalog.plugins.length || catalog.dropped) && !entry) {
    const known = catalog.plugins.map(nameOf);
    const close = suggest(plugin, known);
    const declared = catalog.dropped === 1 ? 'one entry' : `${catalog.dropped} entries`;
    throw new UserError(`Plugin '${plugin}' is not listed in ${shown}.`, {
      hint: close.length
        ? `Did you mean: ${close.join(', ')}?  Run 'list' to see all ${known.length}.`
        : known.length
          ? `Run 'list' to see the ${known.length} available plugins.`
          : `The registry declares ${declared}, but none has a usable string 'name'.`,
    });
  }

  const resolvedMarketplace = marketplace || catalog?.marketplace;
  if (!resolvedMarketplace) {
    throw new UserError(`Could not determine the marketplace name for ${shown}.`, {
      hint: `No 'name' in ${REGISTRY_FILES[0]}. Pass --marketplace <name>.`,
    });
  }

  // Claude Code requires a kebab-case marketplace id. Catching it here names the
  // real problem; otherwise the failure surfaces much later as a bare
  // "plugin not found in marketplace" from the Claude CLI.
  if (!MARKETPLACE_RE.test(resolvedMarketplace)) {
    throw new UserError(`Marketplace name '${resolvedMarketplace}' is not a valid identifier.`, {
      hint: `It must be kebab-case with no spaces (e.g. my-marketplace). Fix 'name' in ${REGISTRY_FILES[0]}.`,
    });
  }

  return {
    plugin,
    repo,
    ref,
    marketplace: resolvedMarketplace,
    sourcePath: sourcePathFor(entry, plugin),
    // Coerced here so the declared `description: string` contract holds even
    // when a registry ships a number or object in the field.
    description: isPlainObject(entry) && nonEmptyString(entry.description) ? entry.description : '',
    catalogFound: Boolean(catalog),
  };
}
