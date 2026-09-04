import test from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';

import { format as f, POSIX_DISPLAY, WINDOWS_DISPLAY } from '../../src/prompts/format.js';
import { DirectoryPath, rulesFor } from '../../src/types/file/paths.js';

const HOME = '/home/dev';
const SEP = String.fromCharCode(92);
const WIN_HOME = 'C:' + SEP + 'Users' + SEP + 'dev';

test('a path under the home directory is shown with a tilde', () => {
  const home = process.platform === 'win32' ? WIN_HOME : HOME;
  const inside = path.join(home, '.cursor', 'plugins');
  assert.equal(f.path(inside, home), `~${path.sep}.cursor${path.sep}plugins`);
  assert.equal(f.path(path.join('/elsewhere', 'x'), home), path.join('/elsewhere', 'x'));
});

/**
 * A bare prefix test collapsed any path that merely started with the home
 * string, so a sibling directory was printed as one inside the home: with a
 * home of `/home/dev`, `/home/dev-config/Code/User` came out as
 * `~/-config/Code/User`. Every "Installed ->", "Removed ->" and "add this entry
 * yourself" line names a path the user is expected to act on, so a path that
 * does not exist is worse than a long one. Reachable with no override at all,
 * through XDG_CONFIG_HOME.
 */
test('a sibling whose name merely extends the home path is left alone', () => {
  assert.equal(f.path('/home/dev-config/Code/User', HOME), '/home/dev-config/Code/User');
  assert.equal(f.path('/home/developer/.cursor', HOME), '/home/developer/.cursor');
  assert.equal(f.path('/home/dev2/.cursor', HOME), '/home/dev2/.cursor');
});

test('a forward slash is a boundary under either platform rules', () => {
  assert.equal(f.path('/home/dev/.cursor', HOME, POSIX_DISPLAY), '~/.cursor');
  assert.equal(f.path('/home/dev/.cursor', HOME, WINDOWS_DISPLAY), '~/.cursor');
});

/**
 * The two platform behaviours, both asserted from whichever host runs this.
 * They used to be read from the host inside the function, so the only way to
 * exercise either was to be on that platform - and these assertions claimed the
 * Windows answer unconditionally, which is how they passed on Windows and then
 * failed the entire POSIX half of the matrix the moment the code was corrected.
 */
test('a backslash is a boundary on Windows and a filename character on POSIX', () => {
  const winPath = WIN_HOME + SEP + '.cursor';
  assert.equal(f.path(winPath, WIN_HOME, WINDOWS_DISPLAY), '~' + SEP + '.cursor');
  assert.equal(f.path(winPath, WIN_HOME, POSIX_DISPLAY), winPath, 'part of the name here');
  // A real POSIX case: a file literally named `dev\backup` sitting in /home.
  const named = HOME + SEP + 'backup';
  assert.equal(f.path(named, HOME, POSIX_DISPLAY), named);
});

test('case is folded on Windows, where the filesystem folds it, and not on POSIX', () => {
  assert.equal(f.path('/home/DEV/plugins', HOME, WINDOWS_DISPLAY), '~/plugins');
  assert.equal(
    f.path('/home/DEV/plugins', HOME, POSIX_DISPLAY),
    '/home/DEV/plugins',
    'two spellings are two directories here',
  );
});

test('the home directory itself is just the tilde', () => {
  assert.equal(f.path(HOME, HOME), '~');
});

test('a trailing separator on the home does not move the boundary', () => {
  assert.equal(f.path('/home/dev/.cursor', '/home/dev/'), '~/.cursor');
  assert.equal(f.path('/home/dev-config/x', '/home/dev/'), '/home/dev-config/x');
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

/**
 * The trim that stops a trailing separator moving the boundary can reduce the
 * home to nothing, and every string starts with nothing - so every absolute
 * path was rewritten as though it sat inside the home. Reachable with HOME=/.
 */
test('a home of just the root leaves paths alone', () => {
  assert.equal(f.path('/etc/passwd', '/'), '/etc/passwd');
  assert.equal(f.path('/etc/passwd', '//'), '/etc/passwd');
  assert.equal(f.path('/etc/passwd', path.sep), '/etc/passwd');
});

test('the default rules are the ones this host actually uses', () => {
  const expected = process.platform === 'win32' ? WINDOWS_DISPLAY : POSIX_DISPLAY;
  const target = HOME + SEP + 'backup';
  assert.equal(f.path(target, HOME), f.path(target, HOME, expected));
});
