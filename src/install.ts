import type { InstallRequest } from './actions/install.js';
import type { UninstallRequest } from './actions/uninstall.js';
import type { UpdateRequest } from './actions/update.js';
import { InstallCommand } from './commands/install.js';
import { UninstallCommand } from './commands/uninstall.js';
import { UpdateCommand } from './commands/update.js';
import { createSession } from './infrastructure/session.js';
import { log } from './log.js';
import { announceMarketplace } from './prompts/marketplace.js';
import type { Deps } from './types/ports.js';
import type { InstallResult, UninstallResult, UpdateResult } from './types/reports.js';
import type { Session } from './types/session.js';
import type { TrackFn } from './types/telemetry.js';
import { errorMessage, throwFailure } from './util.js';

const noTrack: TrackFn = () => {};

// A sink listens; it never takes part. Whatever it throws stays out of the run,
// which has already written its files by the time the success events fire.
function sinkOf(deps: Deps | undefined): TrackFn {
  const track = deps?.track;
  if (!track) return noTrack;
  return (name, properties) => {
    try {
      track(name, properties);
    } catch (err) {
      log.debug(`telemetry: ${errorMessage(err)}`);
    }
  };
}

/**
 * The install path is `commands/install.ts` over `actions/install.ts` now; this
 * is the shim `update` and `cli.ts` still call.
 */
export type InstallOptions = InstallRequest & {
  /** Shared per-run work; `update` threads one through every plugin. */
  session?: Session;
};

export async function installPlugin({ session, ...req }: InstallOptions): Promise<InstallResult> {
  const ownSession = !session;
  const run = session || createSession({ deps: req.deps, notify: announceMarketplace });
  try {
    const result = await new InstallCommand(sinkOf(req.deps)).run(req, run);
    if (result.failure) throwFailure(result.failure);
    return result.report;
  } finally {
    if (ownSession) await run.cleanup();
  }
}

/**
 * The uninstall path is `commands/uninstall.ts` over `actions/uninstall.ts`
 * now; this is the shim `update` and `cli.ts` still call, and it goes with
 * `updateAll` in the next slice.
 */
export type UninstallOptions = UninstallRequest;

export async function uninstallPlugin(options: UninstallOptions): Promise<UninstallResult> {
  const result = await new UninstallCommand(sinkOf(options.deps)).run(options);
  if (result.failure) throwFailure(result.failure);
  return result.report;
}

/**
 * The last shim: `update` and `list` are commands now, and the only thing left
 * here is the telemetry sink the three of them share until Phase 6 builds one.
 */
export type UpdateOptions = UpdateRequest;

export async function updateAll(options: UpdateOptions): Promise<UpdateResult> {
  const result = await new UpdateCommand(sinkOf(options.deps)).run(options);
  return result.report;
}
