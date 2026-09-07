import { exists, replaceDir, rmrf } from '../infrastructure/file-system.js';
import * as paths from '../infrastructure/paths.js';
import type { DirectoryPath } from '../types/file/paths.js';
import {
  TITLES,
  type CursorEvent,
  type Harness,
  type HarnessContext,
  type HarnessName,
  type HarnessOpts,
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
  readonly needsSource = true;

  detect(opts?: HarnessOpts): boolean {
    return exists(paths.cursorRoot(opts));
  }

  location(opts?: HarnessOpts): DirectoryPath {
    return paths.cursorRoot(opts);
  }

  private destFor(plugin: string, opts?: HarnessOpts): DirectoryPath {
    return paths.cursorLocalDir(opts).join(plugin);
  }

  private say(ctx: HarnessContext, event: CursorEvent): void {
    ctx.listener(event);
  }

  async install(ctx: HarnessContext, opts?: HarnessOpts): Promise<boolean> {
    const { plugin, srcDir } = ctx;
    if (!this.detect(opts)) {
      this.say(ctx, { harness: 'cursor', kind: 'not-installed', root: this.location(opts) });
      return false;
    }
    if (!srcDir) {
      this.say(ctx, { harness: 'cursor', kind: 'no-source' });
      return false;
    }
    if (!exists(srcDir.file('.cursor-plugin', 'plugin.json'))) {
      this.say(ctx, { harness: 'cursor', kind: 'no-plugin-json' });
    }

    const dest = this.destFor(plugin, opts);
    replaceDir(srcDir, dest);

    this.say(ctx, { harness: 'cursor', kind: 'copied', dest });
    this.say(ctx, { harness: 'cursor', kind: 'reload', after: 'install' });
    return true;
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
