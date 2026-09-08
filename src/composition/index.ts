import { packageVersion } from '../infrastructure/environment.js';
import { openManifest } from '../infrastructure/manifest-store.js';
import * as paths from '../infrastructure/paths.js';
import { createSession } from '../infrastructure/session.js';
import {
  createTelemetry,
  setTelemetryEnabled,
  telemetryStatus,
} from '../infrastructure/telemetry-service.js';
import type { Services } from '../types/services.js';
import { errorMessage } from '../types/util.js';
import { readBrand } from './brand.js';

// The composition root: the one place that names a concrete service. Nothing
// else in `src/` may import this directory, and `src/commands/` may not import
// `src/infrastructure/` at all, so this is the only route a service takes to
// reach a command. `Services` itself is a port in `types/services.ts`, which is
// what lets the router take it without naming what implements it.

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

  session: (notify, deps) => createSession({ deps, notify }),

  sink: (telemetry, debug) => (event) => {
    try {
      telemetry.report(event);
    } catch (err) {
      debug(`telemetry: ${errorMessage(err)}`);
    }
  },
});
