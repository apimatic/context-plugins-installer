import * as fs from 'node:fs';

import { harnesses } from '../harnesses/index.js';
import { ensureDir, rmrf } from '../infrastructure/file-system.js';
import { ghHeaders, rawUrl, readRegistry } from '../infrastructure/github-registry-client.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import { run, which } from '../infrastructure/process-runner.js';
import { telemetryStatus } from '../infrastructure/telemetry-service.js';
import { format as f } from '../prompts/format.js';
import { describeTelemetry } from '../prompts/telemetry.js';
import { BIN, type Brand } from '../types/brand.js';
import { REGISTRY_FILES } from '../types/catalog.js';
import type { DoctorCheck, DoctorReport } from '../types/doctor.js';
import type { PathOpts } from '../types/env.js';
import { everyEditor } from '../types/harness.js';
import { MarketplaceName } from '../types/ids/marketplace-name.js';
import type { Deps, FetchLike } from '../types/ports.js';
import type { MarketplaceListener } from '../types/session.js';
import { isPlainObject, errorMessage } from '../types/util.js';
import { ActionResult } from './action-result.js';

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

export interface DoctorRequest {
  brand: Brand;
  deps?: Deps;
  pathOpts?: PathOpts;
}

/**
 * Four groups of checks, none of which may throw: a broken check is a result.
 * Every one answers with `DoctorCheck`es rather than printing, which is what
 * lets `--json` and the grid be the same run rendered two ways.
 */
export class DoctorAction {
  /**
   * From `DoctorCommand`, for the same reason as `ListAction`: the checks are a
   * report the command renders, so the progress lines the registry read
   * produces are the only thing this action says, and it does not own them.
   */
  constructor(
    private readonly notify: MarketplaceListener,
    private readonly deps: Deps = {},
    private readonly pathOpts?: PathOpts,
  ) {}

  private async environment(): Promise<DoctorCheck[]> {
    const { deps, pathOpts } = this;
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
      let detail = f.path(git, pathOpts?.home);
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

  private editors(): DoctorCheck[] {
    const { pathOpts } = this;
    const checks = harnesses
      .all()
      .map((h) =>
        h.detect(pathOpts)
          ? ok(h.title, f.path(h.location(pathOpts), pathOpts?.home))
          : warn(
              h.title,
              `not installed (looked in ${f.path(h.location(pathOpts), pathOpts?.home)})`,
            ),
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

  private async marketplace(brand: Brand): Promise<DoctorCheck[]> {
    const { deps } = this;
    const fetchImpl: FetchLike = deps.fetchImpl || fetch;
    const env = deps.env || process.env;
    const checks: DoctorCheck[] = [];

    // The registry client answers with a `Result` and its own progress events,
    // so there is nothing to catch: what used to be a throw, with a hint pulled
    // off the error class, is the failure's own message and hint.
    const read = await readRegistry({
      repo: brand.repo,
      ref: brand.ref,
      deps,
      notify: this.notify,
    });
    if (!read.ok) {
      checks.push(fail('Reachable', read.error.message, read.error.hint));
      return checks;
    }
    checks.push(ok('Reachable', new URL(rawUrl(brand.repo, brand.ref, REGISTRY_FILES[0])).host));

    const catalog = read.value;
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
  private telemetry(brand: Brand): DoctorCheck {
    const { deps, pathOpts } = this;
    const status = telemetryStatus({ brand, env: deps.env || process.env, pathOpts });
    return ok('Telemetry', describeTelemetry(status, BIN));
  }

  private state(brand: Brand): DoctorCheck[] {
    const { pathOpts } = this;
    const dir = paths.stateDir(pathOpts);
    const checks: DoctorCheck[] = [];
    try {
      ensureDir(dir);
      const probe = dir.file(`.write-probe-${process.pid}`);
      fs.writeFileSync(probe.toString(), 'ok');
      rmrf(probe);
      checks.push(ok('State directory', `${f.path(dir, pathOpts?.home)} (writable)`));
    } catch (err) {
      checks.push(
        fail(
          'State directory',
          `${f.path(dir, pathOpts?.home)} is not writable`,
          errorMessage(err),
        ),
      );
    }

    try {
      const {
        plugins: entries,
        ignored,
        elided,
      } = openManifest(paths.manifestPath(pathOpts)).read();
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
    checks.push(this.telemetry(brand));
    return checks;
  }

  /** Never throws: a broken check is a result. Exit 1 is the failures alone. */
  readonly execute = async (brand: Brand): Promise<ActionResult<DoctorReport>> => {
    const groups = [
      { title: 'Environment', checks: await this.environment() },
      { title: 'Editors', checks: this.editors() },
      { title: 'Marketplace', checks: await this.marketplace(brand) },
      { title: 'Local state', checks: this.state(brand) },
    ];
    const all = groups.flatMap((g) => g.checks);
    const report: DoctorReport = {
      groups,
      failures: all.filter((c) => c.status === 'fail').length,
      warnings: all.filter((c) => c.status === 'warn').length,
      ok: !all.some((c) => c.status === 'fail'),
    };
    // No `Failure`: the checks and the summary have said it all already.
    return report.ok ? ActionResult.success(report) : ActionResult.failed(report);
  };
}

function rateLimitOf(body: unknown): { remaining: number; limit: number } | null {
  if (!isPlainObject(body) || !isPlainObject(body.resources)) return null;
  const core = body.resources.core;
  if (!isPlainObject(core)) return null;
  const { remaining, limit } = core;
  return typeof remaining === 'number' && typeof limit === 'number' ? { remaining, limit } : null;
}
