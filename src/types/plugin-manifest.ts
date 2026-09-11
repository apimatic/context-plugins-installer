import { Failure } from './failure.js';
import { PluginId } from './ids/plugin-id.js';
import { err, ok, type Result } from './result.js';
import { isPlainObject, nonEmptyString } from './util.js';

// A plugin's own manifest as this build reads it. The bytes are read by
// infrastructure - from a directory for a local source, over both GitHub hosts
// for a remote one - and this is the one place they become a plugin's identity,
// so neither reader has to decide what a usable manifest is. The same split as
// `normalize` in `types/catalog.ts`, which does this for a marketplace registry.

/**
 * Where a plugin declares itself, in the order they are tried. Claude Code's
 * own location leads; the other two are what the plugins in this marketplace
 * also carry, and a plugin written for one editor should not be unreadable
 * here because it put its manifest where that editor looks.
 */
export const MANIFEST_FILES: readonly string[] = Object.freeze([
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  'plugin.json',
]);

export interface PluginManifest {
  /**
   * What the plugin calls itself, validated. It is the id for everything
   * downstream - the destination folder under each editor, half the manifest
   * key, and the left half of `<plugin>@<marketplace>` - which is why it comes
   * from here and never from the folder's name: a directory can be renamed
   * without the plugin inside it changing what it is.
   */
  id: PluginId;
  description: string;
}

/**
 * One manifest, or why it is not usable. `from` names the file for the message,
 * because "no usable plugin name" is only actionable if the user knows which of
 * the three this build was reading.
 */
export function readManifest(data: unknown, from: string): Result<PluginManifest, Failure> {
  if (!isPlainObject(data)) {
    return err(new Failure(`${from} is not a JSON object.`));
  }
  const id = PluginId.parse(data.name);
  if (!id.ok) {
    return err(
      new Failure(
        nonEmptyString(data.name)
          ? `${from} declares the name ${JSON.stringify(data.name)}, which is not a usable plugin id.`
          : `${from} declares no plugin name.`,
        id.error.hint,
      ),
    );
  }
  // The declared `version` is deliberately not read. Claude Code caches a
  // plugin under `<marketplace>/<id>/<version>`, so an edited plugin whose
  // version did not move would re-install and copy nothing - and that is
  // answered by removing it before installing, in the harness, rather than by
  // a comparison here that nothing would be able to act on.
  return ok({
    id: id.value,
    description: nonEmptyString(data.description) ? data.description : '',
  });
}
