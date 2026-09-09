import { exists, replaceDir, rmrf } from '../infrastructure/file-system.js';
import * as paths from '../infrastructure/paths.js';
import { addPluginLocation, removePluginLocation } from '../infrastructure/vscode-settings.js';
import type { DirectoryPath } from '../types/file/paths.js';
import {
  TITLES,
  type Harness,
  type HarnessContext,
  type HarnessName,
  type HarnessOpts,
  type InstallOutcome,
  type UninstallOutcome,
  type VscodeEvent,
} from '../types/harness.js';
import { ok, type Result } from '../types/result.js';
import type { Failure } from '../types/failure.js';
import type { AddLocationResult, RemoveLocationResult } from '../types/vscode-settings.js';

/**
 * VS Code loads a plugin from any folder listed in chat.pluginLocations, so the
 * copy lives under this tool's state dir rather than in VS Code's storage - and
 * unlike Cursor, needs no detect() gate on uninstall: the copy is readable
 * whether or not VS Code is installed.
 */
export class VscodeHarness implements Harness {
  readonly name: HarnessName = 'vscode';
  readonly title = TITLES.vscode;

  detect(opts?: HarnessOpts): boolean {
    return exists(paths.vscodeUserDir(opts));
  }

  location(opts?: HarnessOpts): DirectoryPath {
    return paths.vscodeUserDir(opts);
  }

  /** Its install is a directory copy, so the files are needed whatever the origin. */
  needsSource(): boolean {
    return true;
  }

  private destFor(plugin: string, opts?: HarnessOpts): DirectoryPath {
    return paths.vscodeStoreDir(opts).join(plugin);
  }

  private say(ctx: HarnessContext, event: VscodeEvent): void {
    ctx.listener(event);
  }

  /** Said last either way, so a backup is reported after the edit it belongs to. */
  private sayBackup(ctx: HarnessContext, result: AddLocationResult | RemoveLocationResult): void {
    if (result.backup) {
      this.say(ctx, { harness: 'vscode', kind: 'settings-backed-up', backup: result.backup });
    }
  }

  async install(ctx: HarnessContext, opts?: HarnessOpts): Promise<Result<InstallOutcome, Failure>> {
    const { plugin, srcDir } = ctx;
    if (!this.detect(opts)) {
      this.say(ctx, { harness: 'vscode', kind: 'not-installed', root: this.location(opts) });
      return ok('skipped');
    }
    if (!srcDir) {
      this.say(ctx, { harness: 'vscode', kind: 'no-source' });
      return ok('skipped');
    }

    const dest = this.destFor(plugin, opts);
    replaceDir(srcDir, dest);

    const settings = paths.vscodeSettingsPath(opts);
    const result = addPluginLocation(settings, dest);

    this.say(ctx, { harness: 'vscode', kind: 'copied', dest });
    // The files are in place either way, so this stays a success with a caveat -
    // reporting a skip would leave the copy on disk with nothing recorded to remove it.
    if (result.action === 'failed') {
      this.say(ctx, { harness: 'vscode', kind: 'settings-failed', settings, dest });
    } else if (result.action === 'conflict') {
      this.say(ctx, { harness: 'vscode', kind: 'settings-conflict', settings, dest });
    } else if (result.action === 'already') {
      this.say(ctx, { harness: 'vscode', kind: 'settings-already', settings });
    } else {
      this.say(ctx, { harness: 'vscode', kind: 'settings-registered', settings });
    }
    this.sayBackup(ctx, result);
    this.say(ctx, { harness: 'vscode', kind: 'reload', after: 'install' });
    return ok('installed');
  }

  async uninstall(ctx: HarnessContext, opts?: HarnessOpts): Promise<UninstallOutcome> {
    const dest = this.destFor(ctx.plugin, opts);
    const settings = paths.vscodeSettingsPath(opts);
    const result = removePluginLocation(settings, dest);
    const had = exists(dest);
    if (had) rmrf(dest);

    // Always said: unmentioned, it survives the uninstall and the next install
    // reports "Already registered" for an entry that never loads the plugin.
    if (result.action === 'unremovable') {
      this.say(ctx, { harness: 'vscode', kind: 'settings-unremovable', settings, dest });
    }
    // The record still follows the files below: a leftover settings entry is a
    // separate mess to clean up, not a reason to keep claiming an install.

    // The outcome follows the files: with no copy there is nothing for VS Code to
    // load, whatever the settings say. No detect() gate, unlike Cursor - the copy
    // is in this tool's own state dir, readable either way.
    if (!had && result.action !== 'removed') {
      this.say(ctx, { harness: 'vscode', kind: 'nothing-to-remove', dest });
      return 'absent';
    }
    // Only claim the directory when there was one.
    if (had) this.say(ctx, { harness: 'vscode', kind: 'removed', dest });
    else this.say(ctx, { harness: 'vscode', kind: 'unregistered-only', dest });
    if (result.action === 'removed') {
      this.say(ctx, { harness: 'vscode', kind: 'settings-unregistered', settings });
    }
    this.sayBackup(ctx, result);
    this.say(ctx, { harness: 'vscode', kind: 'reload', after: 'uninstall' });
    return 'removed';
  }
}
