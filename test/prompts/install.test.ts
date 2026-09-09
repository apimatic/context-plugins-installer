import test from 'node:test';
import assert from 'node:assert';

import { InstallPrompts, type Ask } from '../../src/prompts/install.js';
import type { HarnessName } from '../../src/types/harness.js';
import { silenceConsole } from '../helpers.js';

// The asking, and the lines around it. Which of the three answers a run gets is
// `chooseTargets` in test/application/target-selection.test.ts; that the action
// wires the two together is the end-to-end install tests.

const TARGETS: HarnessName[] = ['cursor', 'vscode'];

type Confirm = Ask & { asked: string[] };

/** Records what was asked, and answers from a scripted list of booleans. */
function scripted(answers: boolean[]): Confirm {
  const asked: string[] = [];
  const fn = async (question: string): Promise<boolean> => {
    asked.push(question);
    return answers.shift() ?? true;
  };
  return Object.assign(fn, { asked });
}

async function quietly<T>(fn: () => Promise<T> | T): Promise<{ value: T; lines: string[] }> {
  const con = silenceConsole();
  try {
    return { value: await fn(), lines: con.lines };
  } finally {
    con.restore();
  }
}

test('every detected editor is one question, in the order given', async () => {
  const confirm = scripted([true, false]);
  const prompts = new InstallPrompts(undefined, confirm);

  const { value } = await quietly(() => prompts.askHarnesses(TARGETS));

  assert.deepEqual(value, ['cursor'], 'and one said no');
  assert.deepEqual(confirm.asked, ['Install into Cursor?', 'Install into VS Code?']);
});

test('saying no to everything chooses nothing, rather than falling back to all', async () => {
  const confirm = scripted([false, false]);
  const prompts = new InstallPrompts(undefined, confirm);

  const { value } = await quietly(() => prompts.askHarnesses(TARGETS));

  assert.deepEqual(value, []);
});

/**
 * The "nobody to ask" line. Taking every detected editor is right - the run
 * must not hang - but silence there would read as the user having chosen them.
 */
test('with nobody to ask, the reason is said out loud', async () => {
  const prompts = new InstallPrompts();

  const { lines } = await quietly(() => prompts.nobodyToAsk());

  // Rewrapped: the line is wider than the terminal, so it arrives in two.
  const text = lines.join(' ').split(/\s+/).filter(Boolean).join(' ');
  assert.match(text, /Non-interactive shell/);
  assert.match(text, /--targets to choose/);
});

/**
 * The connector under the prompt flow has to be closed by whatever line comes
 * next, so the two shapes of "what happened after the questions" differ by
 * whether any were drawn - which is why the prompts class remembers.
 */
test('the line after the questions closes the flow only when one was drawn', async () => {
  const asked = new InstallPrompts(undefined, undefined);
  const { lines: withFlow } = await quietly(async () => {
    // No injected confirm and no terminal: `askHarnesses` draws the flow.
    await asked.askHarnesses([]).catch(() => []);
    asked.installingInto(TARGETS);
  });

  const told = new InstallPrompts(undefined, scripted([]));
  const { lines: noFlow } = await quietly(async () => {
    await told.askHarnesses([]);
    told.installingInto(TARGETS);
  });

  const last = (lines: string[]) => lines[lines.length - 1] ?? '';
  assert.match(last(withFlow), /Installing into: Cursor, VS Code/);
  assert.match(last(noFlow), /Installing into: Cursor, VS Code/);
  assert.notEqual(
    last(withFlow),
    last(noFlow),
    'the same words, but one closes a connector and the other does not',
  );
});

test('a run that changed nothing asks whether the editors are installed', async () => {
  const prompts = new InstallPrompts();

  const { lines } = await quietly(() => prompts.summary([], []));

  const text = lines.join(' ');
  assert.match(text, /Nothing was changed/);
  assert.match(text, /Claude Code \/ Cursor \/ VS Code/, 'the editor list comes from TITLES');
});

test('a summary names what was installed, and what was already there', async () => {
  const prompts = new InstallPrompts();

  const { lines } = await quietly(() => prompts.summary(['cursor'], ['vscode']));

  const text = lines.join(' ');
  assert.match(text, /Installed into: Cursor/);
  assert.match(text, /Already installed: VS Code/);
});

test('the no-editor failure names the editor when the user did, and the list when not', () => {
  const named = InstallPrompts.noEditor(true, ['cursor']);
  assert.match(named.message, /^Cursor is not installed on this machine\.$/);
  assert.match(named.hint, /--targets claude,cursor,vscode/);

  const two = InstallPrompts.noEditor(true, ['cursor', 'vscode']);
  assert.match(two.message, /^Cursor and VS Code are not installed on this machine\.$/);

  const none = InstallPrompts.noEditor(false, ['cursor', 'vscode']);
  assert.match(none.message, /No supported editor found/);
  assert.match(none.hint, /Claude Code, Cursor, or VS Code/);
});
