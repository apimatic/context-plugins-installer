import test from 'node:test';
import assert from 'node:assert';

import { InstalledPrompts } from '../../src/prompts/installed.js';
import { log } from '../../src/prompts/terminal.js';
import type { ManifestEntry } from '../../src/types/installed-record.js';
import type { InstalledReport } from '../../src/types/reports.js';
import { silenceConsole } from '../helpers.js';

// Where a row says it came from. One line each, and the only place a recorded
// key is turned back into something the user would recognise - so a key shape
// added without a case here would print `archive:https://...` at somebody.

const report = (entry: ManifestEntry): InstalledReport => ({
  entries: [entry],
  want: ['cursor'],
  scoped: false,
  gaps: { version: 1, plugins: [], ignored: [], elided: [] },
});

function rendered(entry: ManifestEntry): string {
  const con = silenceConsole();
  log.setVerbose(true);
  try {
    new InstalledPrompts().render(report(entry));
  } finally {
    log.setVerbose(false);
    con.restore();
  }
  return con.lines.join('\n');
}

const row = (over: Partial<ManifestEntry>): ManifestEntry => ({
  plugin: 'my-sdk',
  marketplace: 'apimatic',
  targets: ['cursor'],
  ...over,
});

test('a marketplace row is named by its repo and ref', () => {
  const said = rendered(row({ repo: 'acme/plugin-marketplace', ref: 'main' }));
  assert.match(said, /acme\/plugin-marketplace@main/);
});

test('a directory row is named by the directory', () => {
  const said = rendered(row({ repo: 'local:/opt/dev/my-sdk' }));
  assert.match(said, /\/opt\/dev\/my-sdk/);
  assert.ok(!said.includes('local:'), 'the prefix is a key, not something to read');
});

test('an archive row is named by the archive, and by the folder when there is one', () => {
  const plain = rendered(row({ repo: 'archive:https://acme.com/my-sdk.zip' }));
  assert.match(plain, /https:\/\/acme\.com\/my-sdk\.zip/);
  assert.ok(!plain.includes('archive:'));

  const inside = rendered(row({ repo: 'archive:https://acme.com/mono.zip#tools/foo' }));
  assert.match(inside, /https:\/\/acme\.com\/mono\.zip#tools\/foo/);
});
