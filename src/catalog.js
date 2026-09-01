'use strict';

const { UserError, assertRepo, assertRef, stripBom, suggest } = require('./util');

// Claude Code and Cursor read the same registry shape from different folders.
// We prefer the Claude one and fall back to Cursor's.
const REGISTRY_FILES = ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json'];

// Claude Code's marketplace schema: kebab-case identifier, no spaces.
const MARKETPLACE_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

const rawUrl = (repo, ref, filePath) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`;

function ghHeaders(env = process.env) {
  const headers = { 'User-Agent': 'context-plugins-installer', Accept: 'application/json' };
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
function networkHint(env = process.env) {
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxied) {
    return 'A proxy is configured, but Node does not apply it to its own requests. Check your network, or see the docs for NODE_USE_ENV_PROXY.';
  }
  return 'Check your network connection, or whether access to github.com is blocked.';
}

/** GET JSON, returning null for 404 so a missing registry is not an error. */
async function getJson(url, { env = process.env, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: ghHeaders(env), redirect: 'follow' });
  } catch (err) {
    throw new UserError(`Could not reach ${new URL(url).host}: ${err.message}`, {
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
    return JSON.parse(stripBom(text));
  } catch (err) {
    throw new UserError(`${url} is not valid JSON: ${err.message}`);
  }
}

function normalize(data, from) {
  return {
    marketplace: typeof data.name === 'string' && data.name ? data.name : null,
    plugins: Array.isArray(data.plugins) ? data.plugins : [],
    from,
  };
}

/** Load a repo's marketplace registry. Returns null when the repo has none. */
async function loadCatalog({ repo, ref, deps = {} }) {
  assertRepo(repo);
  assertRef(ref);
  for (const file of REGISTRY_FILES) {
    const data = await getJson(rawUrl(repo, ref, file), deps);
    if (data) return normalize(data, file);
  }
  return null;
}

const entryFor = (catalog, plugin) =>
  catalog
    ? catalog.plugins.find((p) => (typeof p === 'string' ? p : p && p.name) === plugin)
    : undefined;

/** `./plugins/foo` and `plugins/foo` both normalize to the repo-relative `plugins/foo`. */
function sourcePathFor(entry, plugin) {
  const source = entry && typeof entry === 'object' ? entry.source : undefined;
  if (typeof source === 'string' && source.trim()) {
    const rel = source.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel && !rel.includes('..')) return rel;
  }
  if (source && typeof source === 'object') {
    throw new UserError(
      `Plugin '${plugin}' is hosted in another repository (source type '${source.source || 'object'}').`,
      { hint: 'Point --repo at the repository that actually contains the plugin folder.' },
    );
  }
  return `plugins/${plugin}`;
}

/**
 * Resolve everything the installers need for one plugin:
 * the marketplace name (derived unless overridden) and the folder inside the repo.
 */
async function resolvePlugin({
  repo,
  ref,
  plugin,
  marketplace = null,
  label,
  deps = {},
  catalog: preloaded,
}) {
  // `label` is what the user sees; the repository stays an internal detail.
  const shown = label || `${repo}@${ref}`;
  // `undefined` means nobody supplied one; `null` is a valid answer meaning the
  // repository has no registry, so it must not trigger a second fetch.
  const catalog = preloaded === undefined ? await loadCatalog({ repo, ref, deps }) : preloaded;
  const entry = entryFor(catalog, plugin);

  if (catalog && catalog.plugins.length && !entry) {
    const known = catalog.plugins
      .map((p) => (typeof p === 'string' ? p : p && p.name))
      .filter(Boolean);
    const close = suggest(plugin, known);
    throw new UserError(`Plugin '${plugin}' is not listed in ${shown}.`, {
      hint: close.length
        ? `Did you mean: ${close.join(', ')}?  Run 'list' to see all ${known.length}.`
        : `Run 'list' to see the ${known.length} available plugins.`,
    });
  }

  const resolvedMarketplace = marketplace || (catalog && catalog.marketplace);
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
    description: entry && typeof entry === 'object' ? entry.description || '' : '',
    catalogFound: Boolean(catalog),
  };
}

module.exports = {
  REGISTRY_FILES,
  rawUrl,
  ghHeaders,
  getJson,
  normalize,
  loadCatalog,
  entryFor,
  sourcePathFor,
  resolvePlugin,
};
