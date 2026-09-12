import { Failure } from './failure.js';
import { PluginId } from './ids/plugin-id.js';
import { err, ok, type Result } from './result.js';
import { isPlainObject, nonEmptyString } from './util.js';

/** Probe order, Claude Code's own location first. */
export const MANIFEST_FILES: readonly string[] = Object.freeze([
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  'plugin.json',
]);

export interface PluginManifest {
  /** The manifest's own `name`, which is the id everywhere downstream - never the folder's. */
  id: PluginId;
  description: string;
}

/** `from` names the file being read, for the failure message. */
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
  return ok({
    id: id.value,
    description: nonEmptyString(data.description) ? data.description : '',
  });
}
