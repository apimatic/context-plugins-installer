// Programmatic API. The CLI is a thin layer over exactly these functions.
export { installPlugin, uninstallPlugin, updateAll, listPlugins } from './install.js';
export { resolveBrand, DEFAULT_PROFILE } from './brand.js';
export { loadCatalog, resolvePlugin } from './catalog.js';
export { materialize } from './fetch.js';
export { createTelemetry, telemetryStatus, EVENTS } from './telemetry.js';
export { addPluginLocation, removePluginLocation } from './settings-merge.js';
export { UserError } from './util.js';
export * as harness from './harness/index.js';
export * as manifest from './manifest.js';
export * as paths from './paths.js';
export type * from './types.js';
