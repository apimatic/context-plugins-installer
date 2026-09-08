import { packageVersion } from '../infrastructure/environment.js';
import { registryClient } from '../infrastructure/github-registry-client.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import { processRunner } from '../infrastructure/process-runner.js';
import { createSession } from '../infrastructure/session.js';
import { sourceFetcher } from '../infrastructure/source-fetcher.js';
import {
  createTelemetry,
  setTelemetryEnabled,
  telemetryStatus,
} from '../infrastructure/telemetry-service.js';
import type { SourcePorts } from '../types/ports.js';
import type { Services } from '../types/services.js';
import { errorMessage } from '../types/util.js';
import { readBrand } from './brand.js';

// The composition root: the one place that names a concrete service. Nothing
// else in `src/` may import this directory, and `src/commands/` may not import
// `src/infrastructure/` at all, so this is the only route a service takes to
// reach a command. `Services` itself is a port in `types/services.ts`, which is
// what lets the router take it without naming what implements it.

/**
 * The outside, as the two GitHub clients need it. Built here and nowhere else,
 * which is what lets everything below take required ports instead of optional
 * ones with a fallback at the leaf.
 */
const realPorts = (): SourcePorts => ({
  fetch,
  env: process.env,
  runner: processRunner(),
});

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

  session: (notify, ports = realPorts()) =>
    createSession({
      registry: registryClient(ports),
      fetcher: sourceFetcher(ports),
      notify,
    }),

  sink: (telemetry, debug) => (event) => {
    try {
      telemetry.report(event);
    } catch (err) {
      debug(`telemetry: ${errorMessage(err)}`);
    }
  },
});
