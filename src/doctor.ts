import * as fs from 'node:fs';
import * as path from 'node:path';

import { BIN } from './brand.js';
import { loadCatalog, ghHeaders, rawUrl, REGISTRY_FILES } from './catalog.js';
import { HARNESSES, everyEditor } from './harness/index.js';
import * as manifest from './manifest.js';
import * as paths from './paths.js';
import { describeTelemetry, telemetryStatus } from './telemetry.js';
import { MarketplaceName } from './types/ids/marketplace-name.js';
import type { Brand } from './types/brand.js';
import type { DoctorCheck, DoctorReport } from './types/doctor.js';
import type { PathOpts } from './types/env.js';
import type { Deps, FetchLike } from './types/ports.js';
import {
  UserError,
  which,
  run,
  shortPath,
  ensureDir,
  rmrf,
  isPlainObject,
  errorMessage,
} from './util.js';

export const MIN_NODE = 18;

const ok = (label: string, detail: string): DoctorCheck => ({ status: 'ok', label, detail });
const warn = (label: string, detail: string, hint?: string): DoctorCheck => ({
  status: 'warn',
  label,
  detail,
  hint,
});
const fail = (label: string, detail: string, hint?: string): DoctorCheck => ({
  status: 'fail',
  label,
  detail,
  hint,
});

async function checkEnvironment(deps: Deps): Promise<DoctorCheck[]> {
  const whichImpl = deps.which || which;
  const runImpl = deps.run || run;
  const env = deps.env || process.env;
  const checks: DoctorCheck[] = [];

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
      warn(
        'git',
        'not found',
        'Plugins download through the GitHub API instead, which is rate limited to 60 requests an hour.',
      ),
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

function checkEditors(pathOpts?: PathOpts): DoctorCheck[] {
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
        `Install ${everyEditor('or')} - there is nowhere to install a plugin.`,
      ),
    );
  }
  return checks;
}

function rateLimitOf(body: unknown): { remaining: number; limit: number } | null {
  if (!isPlainObject(body) || !isPlainObject(body.resources)) return null;
  const core = body.resources.core;
  if (!isPlainObject(core)) return null;
  const { remaining, limit } = core;
  return typeof remaining === 'number' && typeof limit === 'number' ? { remaining, limit } : null;
}

async function checkMarketplace(brand: Brand, deps: Deps): Promise<DoctorCheck[]> {
  const fetchImpl: FetchLike = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const checks: DoctorCheck[] = [];

  let catalog = null;
  try {
    catalog = await loadCatalog({ repo: brand.repo, ref: brand.ref, deps });
    checks.push(ok('Reachable', new URL(rawUrl(brand.repo, brand.ref, REGISTRY_FILES[0])).host));
  } catch (err) {
    checks.push(
      fail('Reachable', errorMessage(err), err instanceof UserError ? err.hint : undefined),
    );
    return checks;
  }

  if (!catalog) {
    checks.push(fail('Registry', `no ${REGISTRY_FILES[0]} found`, 'Check --repo and --ref.'));
    return checks;
  }

  const name = catalog.marketplace;
  checks.push(
    name && MarketplaceName.create(name)
      ? ok('Registry', `${name}, ${catalog.plugins.length} plugins`)
      : fail(
          'Registry',
          `name ${JSON.stringify(name)} is not a valid identifier`,
          `It must be ${MarketplaceName.RULE}. Fix 'name' in ${REGISTRY_FILES[0]}.`,
        ),
  );

  // Only meaningful when the API is the download path; with git it is unused.
  try {
    const res = await fetchImpl('https://api.github.com/rate_limit', { headers: ghHeaders(env) });
    if (res.ok) {
      const core = rateLimitOf(await res.json());
      if (core) {
        const detail = `${core.remaining} of ${core.limit} requests left`;
        checks.push(
          core.remaining > 10
            ? ok('API budget', detail)
            : warn(
                'API budget',
                detail,
                'Set GITHUB_TOKEN, or install git to avoid the API entirely.',
              ),
        );
      }
    }
  } catch {
    /* advisory only */
  }

  return checks;
}

// Every outcome is `ok`: opting out is a choice, not a problem to fix.
function checkTelemetry(brand: Brand, deps: Deps, pathOpts?: PathOpts): DoctorCheck {
  const status = telemetryStatus({ brand, env: deps.env || process.env, pathOpts });
  return ok('Telemetry', describeTelemetry(status, BIN));
}

function checkState(brand: Brand, deps: Deps, pathOpts?: PathOpts): DoctorCheck[] {
  const dir = paths.stateDir(pathOpts);
  const checks: DoctorCheck[] = [];
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    rmrf(probe);
    checks.push(ok('State directory', `${shortPath(dir)} (writable)`));
  } catch (err) {
    checks.push(fail('State directory', `${shortPath(dir)} is not writable`, errorMessage(err)));
  }

  try {
    const { plugins: entries, ignored, elided } = manifest.read(paths.manifestPath(pathOpts));
    const detail = entries.length
      ? `${entries.length} ${entries.length === 1 ? 'plugin' : 'plugins'}`
      : 'none yet';
    const counts: string[] = [];
    const hints: string[] = [];
    const unreadable = ignored[0];
    const partial = elided[0];
    if (unreadable) {
      const one = ignored.length === 1;
      counts.push(`${ignored.length} ${one ? 'entry' : 'entries'} ignored`);
      hints.push(
        `installed.json holds ${one ? 'an entry' : 'entries'} this build cannot read (${unreadable.reason}); a newer CLI may own ${one ? 'it' : 'them'}.`,
      );
    }
    if (partial) {
      counts.push(`${elided.length} listed in part`);
      hints.push(
        `'${partial.plugin}' records target(s) this build does not know (${partial.targets.join(', ')}), which stay in installed.json.`,
      );
    }
    if (counts.length) {
      checks.push(warn('Installed', `${detail}; ${counts.join(', ')}`, hints.join(' ')));
    } else {
      checks.push(ok('Installed', detail));
    }
  } catch (err) {
    checks.push(warn('Installed', 'could not read installed.json', errorMessage(err)));
  }
  checks.push(checkTelemetry(brand, deps, pathOpts));
  return checks;
}

export interface DiagnoseOptions {
  brand: Brand;
  deps?: Deps;
  pathOpts?: PathOpts;
}

/** Never throws: a broken check is a result. */
export async function diagnose({
  brand,
  deps = {},
  pathOpts,
}: DiagnoseOptions): Promise<DoctorReport> {
  const groups = [
    { title: 'Environment', checks: await checkEnvironment(deps) },
    { title: 'Editors', checks: checkEditors(pathOpts) },
    { title: 'Marketplace', checks: await checkMarketplace(brand, deps) },
    { title: 'Local state', checks: checkState(brand, deps, pathOpts) },
  ];
  const all = groups.flatMap((g) => g.checks);
  return {
    groups,
    failures: all.filter((c) => c.status === 'fail').length,
    warnings: all.filter((c) => c.status === 'warn').length,
    ok: !all.some((c) => c.status === 'fail'),
  };
}
