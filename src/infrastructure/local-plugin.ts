import * as fs from 'node:fs';

import type { PathOpts } from '../types/env.js';
import { Failure } from '../types/failure.js';
import type { DirectoryPath } from '../types/file/paths.js';
import type { PluginId } from '../types/ids/plugin-id.js';
import { MANIFEST_FILES, readManifest, type PluginManifest } from '../types/plugin-manifest.js';
import { err, ok, type Result } from '../types/result.js';
import { errorMessage, stripBom } from '../types/util.js';
import { exists } from './file-system.js';
import * as paths from './paths.js';

export interface LocalPlugin extends PluginManifest {
  dir: DirectoryPath;
}

const destinations = (plugin: PluginId, opts?: PathOpts): DirectoryPath[] => [
  paths.cursorLocalDir(opts).join(plugin.toString()),
  paths.vscodeStoreDir(opts).join(plugin.toString()),
  // The whole generated marketplace, not just this plugin's folder: its
  // registry file is rewritten too.
  paths.localMarketplaceDir(opts),
];

// `replaceDir` removes its destination before copying, so a source overlapping
// one would be deleted before it was read, or copied into itself.
function overlap(dir: DirectoryPath, plugin: PluginId, opts?: PathOpts): DirectoryPath | null {
  for (const dest of destinations(plugin, opts)) {
    if (dir.overlaps(dest)) return dest;
  }
  return null;
}

function readJsonFile(file: string): Result<unknown, Failure> {
  try {
    return ok(JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) as unknown);
  } catch (e) {
    return err(new Failure(`${file} could not be read as JSON: ${errorMessage(e)}`));
  }
}

export function readLocalPlugin(dir: DirectoryPath, opts?: PathOpts): Result<LocalPlugin, Failure> {
  const at = dir.toString();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(at);
  } catch (e) {
    return err(
      new Failure(
        `Could not read ${at}: ${errorMessage(e)}`,
        'Check the path, and that you have permission to read it.',
      ),
    );
  }
  if (!stat.isDirectory()) {
    return err(
      new Failure(
        `${at} is not a directory.`,
        'Point at the plugin folder itself - the one holding .claude-plugin/plugin.json.',
      ),
    );
  }

  let problem: Failure | null = null;
  for (const file of MANIFEST_FILES) {
    const manifestPath = dir.file(...file.split('/'));
    if (!exists(manifestPath)) continue;
    const data = readJsonFile(manifestPath.toString());
    if (!data.ok) {
      problem ??= data.error;
      continue;
    }
    const manifest = readManifest(data.value, manifestPath.toString());
    if (!manifest.ok) {
      problem ??= manifest.error;
      continue;
    }
    const clash = overlap(dir, manifest.value.id, opts);
    if (clash) {
      return err(
        new Failure(
          `${at} is where installing '${manifest.value.id}' would write (${clash}).`,
          'Installing it would delete the source before reading it. Move the plugin somewhere else and try again.',
        ),
      );
    }
    return ok({ ...manifest.value, dir });
  }

  if (problem) return err(problem);
  return err(
    new Failure(
      `${at} does not look like a plugin.`,
      `No plugin manifest there. Looked for ${MANIFEST_FILES.join(', ')}.`,
    ),
  );
}
