import test from 'node:test';
import assert from 'node:assert';

import { announceHarness } from '../../src/prompts/harness/index.js';
import { log } from '../../src/prompts/terminal.js';
import { DirectoryPath, FilePath, rulesFor } from '../../src/types/file/paths.js';
import { NAMES, type HarnessEvent } from '../../src/types/harness.js';

// Every line a harness can say, once each. The harnesses assert which event
// they emit; this asserts the words, so the two halves of "a harness reports
// and a prompts class speaks" are pinned separately - and the strings a user
// reads have one place they can be changed from.
//
// Recorded at `log`, not at the console: the message and its level belong to
// this file, while the glyph in front of it, where the line wraps, and whether
// `debug` is shown at all are terminal.ts's and have their own tests.

const HOME = '/home/dev';
/**
 * POSIX rules, so the expected strings read the same from either host. The real
 * ones rather than a hand-rolled object: a stand-in silently stopped satisfying
 * `PathRules` the moment the interface grew a method, and it only ever had to
 * behave like the thing it was standing in for.
 */
const POSIX = rulesFor('linux');
const CURSOR_ROOT = new DirectoryPath('/home/dev/.cursor', POSIX);
const CODE_USER = new DirectoryPath('/home/dev/.config/Code/User', POSIX);
const DEST = new DirectoryPath('/home/dev/.cursor/plugins/local/my-sdk', POSIX);
const SETTINGS = new FilePath('/home/dev/.config/Code/User/settings.json', POSIX);
const BACKUP = new FilePath('/home/dev/.config/Code/User/settings.json.bak-20260907', POSIX);

type Line = [level: 'ok' | 'info' | 'warn' | 'debug', text: string];

const LEVELS = ['ok', 'info', 'warn', 'debug'] as const;

/** What one event says, in order, as (level, message) pairs. */
function said(event: HarnessEvent, home: string | undefined = HOME): Line[] {
  const lines: Line[] = [];
  const real = LEVELS.map((level) => [level, log[level]] as const);
  for (const level of LEVELS) log[level] = (msg: string) => lines.push([level, msg]);
  try {
    announceHarness(event, home);
  } finally {
    for (const [level, fn] of real) log[level] = fn;
  }
  return lines;
}

const CASES: [HarnessEvent, Line[]][] = [
  // Shared by both file-copying editors: one template with the title filled in.
  [
    { harness: 'cursor', kind: 'not-installed', root: CURSOR_ROOT },
    [['warn', '~/.cursor not found - Cursor not installed, skipping.']],
  ],
  [
    { harness: 'vscode', kind: 'not-installed', root: CODE_USER },
    [['warn', '~/.config/Code/User not found - VS Code not installed, skipping.']],
  ],
  [
    { harness: 'cursor', kind: 'no-source' },
    [['warn', 'No plugin source was fetched - skipping Cursor.']],
  ],
  [
    { harness: 'vscode', kind: 'no-source' },
    [['warn', 'No plugin source was fetched - skipping VS Code.']],
  ],
  [
    { harness: 'cursor', kind: 'copied', dest: DEST },
    [['ok', 'Installed -> ~/.cursor/plugins/local/my-sdk']],
  ],
  [
    { harness: 'vscode', kind: 'copied', dest: DEST },
    [['ok', 'Installed -> ~/.cursor/plugins/local/my-sdk']],
  ],
  [
    { harness: 'cursor', kind: 'removed', dest: DEST },
    [['ok', 'Removed -> ~/.cursor/plugins/local/my-sdk']],
  ],
  [
    { harness: 'cursor', kind: 'nothing-to-remove', dest: DEST },
    [['info', 'Nothing to remove at ~/.cursor/plugins/local/my-sdk']],
  ],

  // The reload hints, keyed by editor. Cursor and VS Code say the same thing
  // whichever way the run went; Claude Code names the direction.
  [
    { harness: 'cursor', kind: 'reload', after: 'install' },
    [['info', 'Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window']],
  ],
  [
    { harness: 'cursor', kind: 'reload', after: 'uninstall' },
    [['info', 'Please reload Cursor: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window']],
  ],
  [
    { harness: 'vscode', kind: 'reload', after: 'install' },
    [['info', 'Please reload VS Code: Ctrl+Shift+P (Cmd+Shift+P) -> Developer: Reload Window']],
  ],
  [
    { harness: 'claude', kind: 'reload', after: 'install' },
    [['info', 'Start with `claude` or /reload-plugins to load newly added plugin.']],
  ],
  [
    { harness: 'claude', kind: 'reload', after: 'uninstall' },
    [['info', 'Restart `claude` or /reload-plugins to unload the plugin.']],
  ],

  // Cursor's own.
  [
    { harness: 'cursor', kind: 'no-plugin-json' },
    [
      [
        'warn',
        'Plugin has no .cursor-plugin/plugin.json - Cursor may not list it. Installing anyway.',
      ],
    ],
  ],

  // VS Code's settings file. The two that ask the user to write the entry
  // themselves spell it exactly as the splice would have.
  [
    { harness: 'vscode', kind: 'unregistered-only', dest: DEST },
    [['ok', 'Nothing was at ~/.cursor/plugins/local/my-sdk - unregistered it']],
  ],
  [
    { harness: 'vscode', kind: 'settings-failed', settings: SETTINGS, dest: DEST },
    [
      ['warn', 'Could not edit ~/.config/Code/User/settings.json - add this entry yourself:'],
      ['info', '"chat.pluginLocations": { "/home/dev/.cursor/plugins/local/my-sdk": true }'],
    ],
  ],
  [
    { harness: 'vscode', kind: 'settings-conflict', settings: SETTINGS, dest: DEST },
    [
      [
        'warn',
        '~/.config/Code/User/settings.json already names this path, but not as an entry that loads it.',
      ],
      ['info', 'Make it read "/home/dev/.cursor/plugins/local/my-sdk": true'],
    ],
  ],
  [
    { harness: 'vscode', kind: 'settings-already', settings: SETTINGS },
    [['info', 'Already registered in ~/.config/Code/User/settings.json']],
  ],
  [
    { harness: 'vscode', kind: 'settings-registered', settings: SETTINGS },
    [['info', 'Registered in chat.pluginLocations (~/.config/Code/User/settings.json)']],
  ],
  [
    { harness: 'vscode', kind: 'settings-unregistered', settings: SETTINGS },
    [['info', 'Unregistered from chat.pluginLocations (~/.config/Code/User/settings.json)']],
  ],
  [
    { harness: 'vscode', kind: 'settings-unremovable', settings: SETTINGS, dest: DEST },
    [
      [
        'warn',
        '~/.config/Code/User/settings.json names ~/.cursor/plugins/local/my-sdk in a form this tool did not write.',
      ],
      ['info', 'Remove that entry by hand - nothing here can take it out safely.'],
    ],
  ],
  [
    { harness: 'vscode', kind: 'settings-backed-up', backup: BACKUP },
    [['debug', 'Backed up settings.json -> settings.json.bak-20260907']],
  ],

  // Claude Code's conversation with its own CLI. None of these has a path in
  // it, which is why that renderer takes no home directory.
  [
    { harness: 'claude', kind: 'cli-missing' },
    [['warn', "'claude' CLI not on PATH - skipping Claude Code."]],
  ],
  [
    { harness: 'claude', kind: 'no-marketplace-name', after: 'install' },
    [['warn', 'No marketplace name to install from - skipping Claude Code.']],
  ],
  [
    { harness: 'claude', kind: 'no-marketplace-name', after: 'uninstall' },
    [['warn', 'No marketplace name to uninstall from - skipping Claude Code.']],
  ],
  [
    { harness: 'claude', kind: 'marketplace-renamed', known: 'apimatic', configured: 'context' },
    [['debug', "Claude knows this marketplace as 'apimatic', not 'context'."]],
  ],
  [
    { harness: 'claude', kind: 'marketplace-registered', known: 'apimatic' },
    [['info', "Marketplace 'apimatic' is already registered - updating it."]],
  ],
  [
    { harness: 'claude', kind: 'marketplace-updated', known: 'apimatic' },
    [['ok', "Updated marketplace 'apimatic'"]],
  ],
  [
    {
      harness: 'claude',
      kind: 'marketplace-update-failed',
      known: 'apimatic',
      code: 7,
      detail: 'network unreachable',
    },
    [
      [
        'warn',
        "Could not update marketplace 'apimatic' (exit 7) - continuing with the local copy. network unreachable",
      ],
    ],
  ],
  [
    { harness: 'claude', kind: 'marketplace-added', marketplace: 'apimatic' },
    [['ok', "Added marketplace 'apimatic'"]],
  ],
  [
    { harness: 'claude', kind: 'marketplace-add-rejected', code: 1, detail: 'already exists' },
    [['debug', 'marketplace add returned 1 (likely already added). already exists']],
  ],
  [
    { harness: 'claude', kind: 'plugin-stale', target: 'my-sdk@apimatic', known: 'apimatic' },
    [['debug', "'my-sdk@apimatic' is not in the local copy - refreshing 'apimatic' and retrying."]],
  ],
  [
    { harness: 'claude', kind: 'plugin-installed', target: 'my-sdk@apimatic', scope: 'user' },
    [['ok', 'Installed my-sdk@apimatic (user scope)']],
  ],
  [
    { harness: 'claude', kind: 'plugin-absent', plugin: 'my-sdk', scope: 'user' },
    [['info', "Claude Code has no 'my-sdk' at user scope - nothing left to remove."]],
  ],
  [
    { harness: 'claude', kind: 'plugin-uninstalled', target: 'my-sdk@apimatic' },
    [['ok', 'Uninstalled my-sdk@apimatic']],
  ],
  [
    {
      harness: 'claude',
      kind: 'plugin-uninstall-failed',
      target: 'my-sdk@apimatic',
      code: 3,
      detail: 'EPERM',
    },
    [['warn', 'claude plugin uninstall my-sdk@apimatic returned 3. EPERM']],
  ],
];

test('every harness event says the line it has always said, at the level it said it', () => {
  for (const [event, expected] of CASES) {
    assert.deepEqual(said(event), expected, `${event.harness}/${event.kind}`);
  }
});

/**
 * The switch in each renderer ends in a `never`, so a kind with no line does
 * not compile. This is the other half: a kind nothing here constructs would
 * have no words asserted, and a new editor could print whatever it liked.
 */
test('the table covers every editor, with no case written twice', () => {
  const seen = new Set(CASES.map(([e]) => JSON.stringify(e)));
  assert.equal(seen.size, CASES.length, 'no event is listed twice');
  for (const name of NAMES) {
    assert.ok(
      CASES.some(([e]) => e.harness === name),
      `${name} says nothing at all - a new editor needs lines of its own`,
    );
  }
});

// `tail()` answers with an empty string when the CLI said nothing, and both of
// these templates have a space before it - which is what the `.trim()` is for.
test('an empty detail leaves no trailing space', () => {
  assert.deepEqual(
    said({
      harness: 'claude',
      kind: 'marketplace-update-failed',
      known: 'apimatic',
      code: 7,
      detail: '',
    }),
    [
      [
        'warn',
        "Could not update marketplace 'apimatic' (exit 7) - continuing with the local copy.",
      ],
    ],
  );
  assert.deepEqual(
    said({
      harness: 'claude',
      kind: 'plugin-uninstall-failed',
      target: 'my-sdk@apimatic',
      code: 3,
      detail: '',
    }),
    [['warn', 'claude plugin uninstall my-sdk@apimatic returned 3.']],
  );
});

/**
 * The home a run reports paths against is the one in `pathOpts`, and it can be
 * absent - a lone `install` builds its options from flags. With none the path
 * is shown as it is rather than guessed at.
 */
test('with no home to read a path against, the path is shown in full', () => {
  assert.deepEqual(said({ harness: 'cursor', kind: 'copied', dest: DEST }, ''), [
    ['ok', 'Installed -> /home/dev/.cursor/plugins/local/my-sdk'],
  ]);
});
