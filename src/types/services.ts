import type { Flags } from './args.js';
import type { Brand } from './brand.js';
import type { PathOpts } from './env.js';
import type { EventSink } from './events/domain-event.js';
import type { Failure } from './failure.js';
import type { ManifestContext } from './manifest-context.js';
import type { Deps, Telemetry, TelemetrySettings } from './ports.js';
import type { Result } from './result.js';
import type { Session } from './session.js';

/**
 * What a run needs built. The router takes this rather than reaching for the
 * real thing itself, which is what lets `src/commands` be barred from
 * `src/infrastructure` altogether: everything below the command line is
 * constructed in `src/composition/`, once, and nowhere else. It is a port and
 * not the wiring for the same reason: a command may name what it needs without
 * naming what builds it.
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
