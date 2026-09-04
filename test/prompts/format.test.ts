import test from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';

import { format as f } from '../../src/prompts/format.js';
import { DirectoryPath, rulesFor } from '../../src/types/file/paths.js';

const HOME = '/home/dev';

test('a path under the home directory is shown with a tilde', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const inside = path.join(home, '.cursor', 'plugins');
  assert.equal(f.path(inside, home), `~${path.sep}.cursor${path.sep}plugins`);
  assert.equal(f.path(path.join('/elsewhere', 'x'), home), path.join('/elsewhere', 'x'));
});

/**
 * A bare prefix test collapsed any path that merely started with the home
 * string, so a sibling directory was printed as one inside the home: with a
 * home of `/home/dev`, `/home/dev-config/Code/User` came out as
 * `~-config/Code/User`. Every "Installed ->", "Removed ->" and "add this entry
 * yourself" line names a path the user is expected to act on, so a path that
 * does not exist is worse than a long one. Reachable with no override at all,
 * through XDG_CONFIG_HOME.
 */
test('a sibling whose name merely extends the home path is left alone', () => {
  assert.equal(f.path('/home/dev-config/Code/User', HOME), '/home/dev-config/Code/User');
  assert.equal(f.path('/home/developer/.cursor', HOME), '/home/developer/.cursor');
  assert.equal(f.path('/home/dev2/.cursor', HOME), '/home/dev2/.cursor');
});

test('the boundary is a separator, whichever kind the path uses', () => {
  assert.equal(f.path('/home/dev/.cursor', HOME), '~/.cursor');
  assert.equal(f.path('C:\\Users\\dev\\.cursor', 'C:\\Users\\dev'), '~\\.cursor');
});

test('the home directory itself is just the tilde', () => {
  assert.equal(f.path(HOME, HOME), '~');
});

test('a trailing separator on the home does not move the boundary', () => {
  assert.equal(f.path('/home/dev/.cursor', '/home/dev/'), '~/.cursor');
  assert.equal(f.path('/home/dev-config/x', '/home/dev/'), '/home/dev-config/x');
});

// A Windows home and APPDATA do not always agree about capitalisation, and both
// name the same directory, so the comparison ignores case.
test('capitalisation does not stop a path being recognised as inside the home', () => {
  assert.equal(f.path('C:\\Users\\DEV\\AppData', 'C:\\Users\\dev'), '~\\AppData');
});

// Every call site hands over a path object rather than a string.
test('a path object is shown the same way a string is', () => {
  const dir = new DirectoryPath(HOME, rulesFor('linux')).join('.context-plugins', 'vscode');
  assert.equal(f.path(dir, HOME), '~/.context-plugins/vscode');
});

test('an empty path, or no home to compare against, is left alone', () => {
  assert.equal(f.path('', HOME), '');
  assert.equal(f.path('/home/dev/x', ''), '/home/dev/x');
});
