import { readBrand } from './brand.js';
import { packageVersion } from './infrastructure/environment.js';
import { openManifest } from './infrastructure/manifest-store.js';
import * as paths from './infrastructure/paths.js';
import { createSession } from './infrastructure/session.js';
import {
  createTelemetry,
  setTelemetryEnabled,
  telemetryStatus,
  type Telemetry,
} from './infrastructure/telemetry-service.js';
import { announceMarketplace } from './prompts/marketplace.js';
import type { Flags } from './types/args.js';
import type { Brand } from './types/brand.js';
import type { PathOpts } from './types/env.js';
import type { EventSink } from './types/events/domain-event.js';
import type { Failure } from './types/failure.js';
import type { ManifestContext } from './types/manifest-context.js';
import type { Deps, TelemetrySettings } from './types/ports.js';
import type { Result } from './types/result.js';
import type { Session } from './types/session.js';
import { errorMessage } from './util.js';

/**
 * What a run needs built. The router takes this rather than reaching for the
 * real thing itself, which is what lets `src/commands` be barred from
 * `src/infrastructure` altogether: everything below the command line is
 * constructed here, once, and nowhere else.
 *
 * Each member is a function rather than a value because none of them may run
 * before the command line is understood - reading the version opens a file, and
 * a `--version` run must answer even when the rc file beside it is broken.
 */
export interface Services {
  /** The published version, read lazily: nothing needs it until something reports. */
  version(): string;
  /** Flags plus both rc files, decided. A `Failure` here is a usage error. */
  brand(flags: Flags): Result<Brand, Failure>;
  /** One instance per run; whatever was reported leaves in a single request. */
  telemetry(brand: Brand, command: string | null): Telemetry;
  manifest(pathOpts?: PathOpts): ManifestContext;
  telemetrySettings(brand: Brand): TelemetrySettings;
  /** Per-run shared work: one registry read, one clone, one marketplace add. */
  session(deps?: Deps): Session;
  /**
   * Where events go. Wrapped so that a sink which throws cannot fail a run
   * that has already written its files - reporting is a courtesy, and this is
   * the one place that can promise it stays one.
   */
  sink(telemetry: Telemetry, debug: (message: string) => void): EventSink;
}

export const services = (): Services => ({
  version: packageVersion,

  brand: (flags) => readBrand({ flags }),

  telemetry: (brand, command) => createTelemetry({ brand, command, version: packageVersion }),

  manifest: (pathOpts) => openManifest(paths.manifestPath(pathOpts)),

  telemetrySettings: (brand) => ({
    file: paths.telemetryPath(),
    status: () => telemetryStatus({ brand }),
    setEnabled: (enabled) => setTelemetryEnabled(enabled),
  }),

  session: (deps) => createSession({ deps, notify: announceMarketplace }),

  sink: (telemetry, debug) => (event) => {
    try {
      telemetry.report(event);
    } catch (err) {
      debug(`telemetry: ${errorMessage(err)}`);
    }
  },
});
