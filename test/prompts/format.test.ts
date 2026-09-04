import test from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';

import { format as f } from '../../src/prompts/format.js';
import { DirectoryPath, rulesFor } from '../../src/types/file/paths.js';

test('a path under the home directory is shown with a tilde', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const inside = path.join(home, '.cursor', 'plugins');
  assert.equal(f.path(inside, home), `~${path.sep}.cursor${path.sep}plugins`);
  assert.equal(f.path(path.join('/elsewhere', 'x'), home), path.join('/elsewhere', 'x'));
});

// Every call site now hands over a path object rather than a string, so the
// formatter has to read one.
test('a path object is shown the same way a string is', () => {
  const home = '/home/dev';
  const dir = new DirectoryPath(home, rulesFor('linux')).join('.context-plugins', 'vscode');
  // The remainder already begins with its own separator, so none is added: a
  // posix path stays readable even when it is displayed on Windows.
  assert.equal(f.path(dir, home), '~/.context-plugins/vscode');
});

test('an empty path, or no home to compare against, is left alone', () => {
  assert.equal(f.path('', '/home/dev'), '');
  assert.equal(f.path('/home/dev/x', ''), '/home/dev/x');
});
