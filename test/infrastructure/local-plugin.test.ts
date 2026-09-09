import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readLocalPlugin } from '../../src/infrastructure/local-plugin.js';
import * as paths from '../../src/infrastructure/paths.js';
import type { PathOpts } from '../../src/types/env.js';
import { DirectoryPath } from '../../src/types/file/paths.js';
import type { Failure } from '../../src/types/failure.js';
import type { Result } from '../../src/types/result.js';
import { cleanupAll, tmpDir } from '../helpers.js';

test.after(cleanupAll);

// A real directory on disk every time, in a sandbox: this module's whole job is
// going and looking, so a fake filesystem would be testing something else.

interface PluginSpec {
  /** Manifest path -> its contents, written verbatim so a broken one can be tried. */
  files?: Record<string, string>;
}

function pluginDir({ files }: PluginSpec = {}): DirectoryPath {
  const dir = path.join(tmpDir('cp-local-'), 'my-plugin');
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'SKILL.md'), '# a skill');
  for (const [at, contents] of Object.entries(files ?? {})) {
    const target = path.join(dir, ...at.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return new DirectoryPath(dir);
}

const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'my-plugin', description: 'A local plugin', version: '1.2.3', ...over });

const failure = <T>(result: Result<T, Failure>): Failure => {
  assert.ok(!result.ok, 'expected a failure');
  return result.error;
};

test('it reads the id, description and version a plugin declares', () => {
  const dir = pluginDir({ files: { '.claude-plugin/plugin.json': manifest() } });
  const read = readLocalPlugin(dir);
  assert.ok(read.ok, read.ok ? '' : read.error.message);
  assert.equal(read.value.id.toString(), 'my-plugin');
  assert.equal(read.value.description, 'A local plugin');
  assert.equal(read.value.version, '1.2.3');
  assert.ok(read.value.dir.isEqual(dir));
});

test('a plugin whose manifest sits where another editor looks is still readable', () => {
  // The plugins in this marketplace carry all three; one written for Cursor
  // alone should not be unreadable here because of where it put its manifest.
  for (const at of ['.cursor-plugin/plugin.json', 'plugin.json']) {
    const read = readLocalPlugin(pluginDir({ files: { [at]: manifest() } }));
    assert.ok(read.ok, `${at}: ${read.ok ? '' : read.error.message}`);
    assert.equal(read.value.id.toString(), 'my-plugin');
  }
});

test('the first manifest with a usable name wins, whichever files exist', () => {
  const dir = pluginDir({
    files: {
      '.claude-plugin/plugin.json': manifest({ name: 'claude-name' }),
      'plugin.json': manifest({ name: 'root-name' }),
    },
  });
  const read = readLocalPlugin(dir);
  assert.ok(read.ok);
  assert.equal(read.value.id.toString(), 'claude-name');
});

test('a manifest with an unusable name explains itself rather than being skipped', () => {
  // The useful half is that it names the file and the value: "no plugin
  // manifest here" would be a lie with the file sitting right there.
  const err = failure(
    readLocalPlugin(
      pluginDir({ files: { '.claude-plugin/plugin.json': manifest({ name: 'My Plugin' }) } }),
    ),
  );
  assert.match(err.message, /\.claude-plugin[/\\]plugin\.json/);
  assert.match(err.message, /"My Plugin"/);
  assert.match(err.hint ?? '', /kebab-case/);
});

test('a manifest with no name at all says so', () => {
  const err = failure(
    readLocalPlugin(
      pluginDir({ files: { 'plugin.json': JSON.stringify({ description: 'no name' }) } }),
    ),
  );
  assert.match(err.message, /declares no plugin name/);
});

test('a manifest that is not JSON is reported as such, with the path', () => {
  const err = failure(
    readLocalPlugin(pluginDir({ files: { '.claude-plugin/plugin.json': '{ not json' } })),
  );
  assert.match(err.message, /could not be read as JSON/);
  assert.match(err.message, /plugin\.json/);
});

test('a directory with no manifest lists the three places it looked', () => {
  const err = failure(readLocalPlugin(pluginDir()));
  assert.match(err.message, /does not look like a plugin/);
  assert.match(err.hint ?? '', /\.claude-plugin\/plugin\.json/);
  assert.match(err.hint ?? '', /\.cursor-plugin\/plugin\.json/);
});

test('a missing path and a file are each their own failure', () => {
  const missing = failure(
    readLocalPlugin(new DirectoryPath(path.join(tmpDir('cp-none-'), 'nope'))),
  );
  assert.match(missing.message, /Could not read/);

  const file = path.join(tmpDir('cp-file-'), 'plugin.json');
  fs.writeFileSync(file, manifest());
  const notDir = failure(readLocalPlugin(new DirectoryPath(file)));
  assert.match(notDir.message, /is not a directory/);
  assert.match(notDir.hint ?? '', /plugin folder itself/);
});

test('a source that is also a destination is refused, not installed from', () => {
  // `replaceDir` removes its destination before copying, so this is the case
  // that would delete the user's plugin before reading it. Both directions are
  // refused: the source being a destination, and the source containing one.
  const root = tmpDir('cp-overlap-');
  const opts: PathOpts = { env: { CP_STATE_DIR: path.join(root, 'state') }, home: root };
  const dest = paths.cursorLocalDir(opts).join('my-plugin');

  fs.mkdirSync(path.join(dest.toString(), '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dest.toString(), '.claude-plugin', 'plugin.json'), manifest());

  const err = failure(readLocalPlugin(dest, opts));
  assert.match(err.message, /would write/);
  assert.match(err.hint ?? '', /delete the source before reading it/);
});

test('a source holding the generated marketplace is refused too', () => {
  const root = tmpDir('cp-holds-');
  const state = path.join(root, 'state');
  const opts: PathOpts = { env: { CP_STATE_DIR: state }, home: root };
  // The state dir's parent contains the generated marketplace, so a plugin
  // rooted there would be copied into itself.
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), manifest());

  const err = failure(readLocalPlugin(new DirectoryPath(root), opts));
  assert.match(err.message, /would write/);
});

test('it never reads the developers real home, only the paths it is given', () => {
  // The guard resolves destinations through `paths.ts`, which reads `PathOpts` -
  // so a test that forgot to sandbox would be asserting against a real machine.
  const root = tmpDir('cp-sandbox-');
  const opts: PathOpts = { env: { CP_STATE_DIR: path.join(root, 'state') }, home: root };
  const dir = pluginDir({ files: { '.claude-plugin/plugin.json': manifest() } });
  const read = readLocalPlugin(dir, opts);
  assert.ok(read.ok, read.ok ? '' : read.error.message);
});
