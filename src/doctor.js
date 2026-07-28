'use strict';

const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const manifest = require('./manifest');
const { HARNESSES } = require('./harness');
const { loadCatalog, ghHeaders, rawUrl, REGISTRY_FILES } = require('./catalog');
const { which, run, shortPath, ensureDir, rmrf } = require('./util');

const MIN_NODE = 18;
const MARKETPLACE_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

const ok = (label, detail) => ({ status: 'ok', label, detail });
const warn = (label, detail, hint) => ({ status: 'warn', label, detail, hint });
const fail = (label, detail, hint) => ({ status: 'fail', label, detail, hint });

async function checkEnvironment(deps) {
  const whichImpl = deps.which || which;
  const runImpl = deps.run || run;
  const env = deps.env || process.env;
  const checks = [];

  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  checks.push(
    major >= MIN_NODE
      ? ok('Node.js', `v${version}`)
      : fail('Node.js', `v${version}`, `Version ${MIN_NODE} or newer is required.`),
  );

  const git = whichImpl('git', env);
  if (git) {
    let detail = shortPath(git);
    try {
      const res = await runImpl(git, ['--version']);
      if (res.code === 0 && res.stdout.trim()) detail = res.stdout.trim();
    } catch {
      /* the path alone is enough */
    }
    checks.push(ok('git', detail));
  } else {
    checks.push(
      warn('git', 'not found', 'Plugins download through the GitHub API instead, which is rate limited to 60 requests an hour.'),
    );
  }

  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxy) {
    checks.push(
      warn(
        'Proxy',
        'configured for the shell',
        'Node does not apply HTTP_PROXY or HTTPS_PROXY to its own requests, so downloads may fail here even where git succeeds.',
      ),
    );
  }

  return checks;
}

function checkEditors(pathOpts) {
  const checks = HARNESSES.map((h) =>
    h.detect(pathOpts)
      ? ok(h.title, h.location(pathOpts))
      : warn(h.title, `not installed (looked in ${h.location(pathOpts)})`),
  );
  if (!checks.some((c) => c.status === 'ok')) {
    checks.push(
      fail(
        'Any editor',
        'none found',
        'Install Claude Code, Cursor, or VS Code - there is nowhere to install a plugin.',
      ),
    );
  }
  return checks;
}

async function checkMarketplace(brand, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const checks = [];

  let catalog = null;
  try {
    catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
    checks.push(ok('Reachable', new URL(rawUrl(brand.repo, brand.ref, REGISTRY_FILES[0])).host));
  } catch (err) {
    checks.push(fail('Reachable', err.message, err.hint));
    return checks;
  }

  if (!catalog) {
    checks.push(fail('Registry', `no ${REGISTRY_FILES[0]} found`, 'Check --repo and --ref.'));
    return checks;
  }

  const name = catalog.marketplace;
  checks.push(
    name && MARKETPLACE_RE.test(name)
      ? ok('Registry', `${name}, ${catalog.plugins.length} plugins`)
      : fail(
          'Registry',
          `name ${JSON.stringify(name)} is not a valid identifier`,
          `It must be kebab-case with no spaces. Fix 'name' in ${REGISTRY_FILES[0]}.`,
        ),
  );

  // Only meaningful when the API is the download path; with git it is unused.
  try {
    const res = await fetchImpl('https://api.github.com/rate_limit', { headers: ghHeaders(env) });
    if (res.ok) {
      const body = await res.json();
      const core = body.resources && body.resources.core;
      if (core) {
        const detail = `${core.remaining} of ${core.limit} requests left`;
        checks.push(core.remaining > 10 ? ok('API budget', detail) : warn('API budget', detail, 'Set GITHUB_TOKEN, or install git to avoid the API entirely.'));
      }
    }
  } catch {
    /* advisory only */
  }

  return checks;
}

function checkState(pathOpts) {
  const dir = paths.stateDir(pathOpts);
  const checks = [];
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    rmrf(probe);
    checks.push(ok('State directory', `${shortPath(dir)} (writable)`));
  } catch (err) {
    checks.push(
      fail('State directory', `${shortPath(dir)} is not writable`, err.message),
    );
  }

  try {
    const entries = manifest.list(paths.manifestPath(pathOpts));
    const detail = entries.length ? `${entries.length} ${entries.length === 1 ? 'plugin' : 'plugins'}` : 'none yet';
    checks.push(ok('Installed', detail));
  } catch (err) {
    checks.push(warn('Installed', 'could not read installed.json', err.message));
  }
  return checks;
}

/** Collect every check, grouped for display. Never throws: a broken check is a result. */
async function diagnose({ brand, deps = {}, pathOpts } = {}) {
  const groups = [
    { title: 'Environment', checks: await checkEnvironment(deps) },
    { title: 'Editors', checks: checkEditors(pathOpts) },
    { title: 'Marketplace', checks: await checkMarketplace(brand, deps) },
    { title: 'Local state', checks: checkState(pathOpts) },
  ];
  const all = groups.flatMap((g) => g.checks);
  return {
    groups,
    failures: all.filter((c) => c.status === 'fail').length,
    warnings: all.filter((c) => c.status === 'warn').length,
    ok: !all.some((c) => c.status === 'fail'),
  };
}

module.exports = { diagnose, MIN_NODE };
