import { exists, replaceDir, rmrf } from '../infrastructure/file-system.js';
import * as paths from '../infrastructure/paths.js';
import type { Failure } from '../types/failure.js';
import type { DirectoryPath } from '../types/file/paths.js';
import { ok, type Result } from '../types/result.js';
import {
  TITLES,
  type CursorEvent,
  type Harness,
  type HarnessContext,
  type HarnessName,
  type HarnessOpts,
  type InstallOutcome,
  type UninstallOutcome,
} from '../types/harness.js';

/**
 * Cursor loads a plugin from a folder under its own root, so the copy goes
 * there - which is why a missing root makes the path unverifiable rather than
 * empty, and an uninstall reports `skipped` instead of `absent`.
 */
export class CursorHarness implements Harness {
  readonly name: HarnessName = 'cursor';
  readonly title = TITLES.cursor;

  detect(opts?: HarnessOpts): boolean {
    return exists(paths.cursorRoot(opts));
  }

  location(opts?: HarnessOpts): DirectoryPath {
    return paths.cursorRoot(opts);
  }

  /** Its install is a directory copy, so the files are needed whatever the origin. */
  needsSource(): boolean {
    return true;
  }

  private destFor(plugin: string, opts?: HarnessOpts): DirectoryPath {
    return paths.cursorLocalDir(opts).join(plugin);
  }

  private say(ctx: HarnessContext, event: CursorEvent): void {
    ctx.listener(event);
  }

  async install(ctx: HarnessContext, opts?: HarnessOpts): Promise<Result<InstallOutcome, Failure>> {
    const { plugin, srcDir } = ctx;
    if (!this.detect(opts)) {
      this.say(ctx, { harness: 'cursor', kind: 'not-installed', root: this.location(opts) });
      return ok('skipped');
    }
    if (!srcDir) {
      this.say(ctx, { harness: 'cursor', kind: 'no-source' });
      return ok('skipped');
    }
    if (!exists(srcDir.file('.cursor-plugin', 'plugin.json'))) {
      this.say(ctx, { harness: 'cursor', kind: 'no-plugin-json' });
    }

    const dest = this.destFor(plugin, opts);
    replaceDir(srcDir, dest);

    this.say(ctx, { harness: 'cursor', kind: 'copied', dest });
    this.say(ctx, { harness: 'cursor', kind: 'reload', after: 'install' });
    return ok('installed');
  }

  async uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<UninstallOutcome> {
    // The plugin dir lives under Cursor's own root, so a missing root makes the
    // path unverifiable rather than empty.
    if (!this.detect(opts)) {
      this.say(ctx, { harness: 'cursor', kind: 'not-installed', root: this.location(opts) });
      return 'skipped';
    }
    const dest = this.destFor(ctx.plugin, opts);
    if (!exists(dest)) {
      this.say(ctx, { harness: 'cursor', kind: 'nothing-to-remove', dest });
      return 'absent';
    }
    rmrf(dest);
    this.say(ctx, { harness: 'cursor', kind: 'removed', dest });
    this.say(ctx, { harness: 'cursor', kind: 'reload', after: 'uninstall' });
    return 'removed';
  }
}
