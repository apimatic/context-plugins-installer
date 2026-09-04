import test from 'node:test';
import assert from 'node:assert';
import { PassThrough, Writable } from 'node:stream';

import { glyphs, parseAnswer, createPrompter } from '../src/prompt.js';

const ESC = String.fromCharCode(27);
const UP_AND_CLEAR = `${ESC}[1A${ESC}[2K\r`;

type FakeTty = Writable & { isTTY: boolean; columns: number; text(): string };

/** A sink that reports itself as a terminal, so the redraw path runs headless. */
function fakeTty({ isTTY = true, columns = 80 } = {}): FakeTty {
  let buf = '';
  const s = new Writable({
    write(c, _e, cb) {
      buf += String(c);
      cb();
    },
  });
  return Object.assign(s, { isTTY, columns, text: () => buf });
}

/** Asks one question, answering with `keys`. Returns [answer, what was written]. */
async function askOnce(
  keys: string,
  { out, question = 'Install into VS Code?' }: { out: FakeTty; question?: string },
): Promise<[boolean, string]> {
  const input = new PassThrough();
  const prompter = createPrompter({ input, out, unicode: true });
  const pending = prompter.confirm(question, true);
  input.write(`${keys}\n`);
  const answer = await pending;
  prompter.close();
  input.end();
  // Colour follows the real stdout, not this sink, so a developer shell with
  // FORCE_COLOR set would otherwise redraw these rows in SGR codes and fail.
  // Only colour is stripped: the cursor moves below are what the assertions read.
  return [answer, out.text().replace(/\x1b\[\d+m/g, '')];
}

test('y, n, and their long forms are all accepted', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', ' Yes ']) {
    assert.equal(parseAnswer(yes, true), true, `${JSON.stringify(yes)} should be yes`);
  }
  for (const no of ['n', 'N', 'no', 'NO', ' No ']) {
    assert.equal(parseAnswer(no, true), false, `${JSON.stringify(no)} should be no`);
  }
});

test('bare Enter takes the default, either way round', () => {
  assert.equal(parseAnswer('', true), true);
  assert.equal(parseAnswer('', false), false);
  assert.equal(parseAnswer('   ', true), true);
});

test('stdin closing mid-question falls back to the default', () => {
  assert.equal(parseAnswer(undefined, true), true);
  assert.equal(parseAnswer(null, false), false);
});

test('anything else is null, so the caller re-asks instead of guessing', () => {
  for (const junk of ['maybe', 'ye', 'yep', 'nope', '1', 'true']) {
    assert.equal(parseAnswer(junk, true), null, `${junk} should not be taken as an answer`);
  }
});

test('the glyphs fall back to ASCII where box drawing would be mojibake', () => {
  const uni = glyphs(true);
  const ascii = glyphs(false);
  assert.equal(uni.step, String.fromCharCode(0x25c6));
  assert.equal(uni.bar, String.fromCharCode(0x2502));
  assert.equal(ascii.step, '*');
  assert.equal(ascii.bar, '|');
  // One column each, so the 3-column gutter lines up in both modes.
  for (const g of [uni, ascii]) {
    assert.equal(g.step.length, 1);
    assert.equal(g.bar.length, 1);
  }
});

test('the answered row is redrawn with its hint, minus the keystroke', async () => {
  const out = fakeTty();
  const [answer, text] = await askOnce('y', { out });
  const g = glyphs(true);

  assert.equal(answer, true);
  const at = text.indexOf(UP_AND_CLEAR);
  assert.ok(at !== -1, 'the row the user typed on is cleared');
  // What replaces it keeps the question AND the hint - only the keystroke goes.
  const after = text.slice(at + UP_AND_CLEAR.length);
  assert.match(after, /^.*Install into VS Code\? \(Y\/n\)\n/);
  assert.ok(!/\(Y\/n\)\s+y/.test(after), 'the keystroke is not carried into the redraw');
  // Then the decision, on its own connector row.
  assert.match(after, new RegExp(`\\${g.bar}\\s+Yes\\n`));
});

test('no cursor tricks when the row could have wrapped, or off a TTY', async () => {
  const narrow = fakeTty({ columns: 10 }); // the asked row cannot fit
  const [, wrapped] = await askOnce('y', { out: narrow });
  assert.ok(!wrapped.includes(UP_AND_CLEAR), 'a row that may have wrapped is left alone');

  const piped = fakeTty({ isTTY: false });
  const [, plain] = await askOnce('n', { out: piped });
  assert.ok(!plain.includes(UP_AND_CLEAR), 'nothing to redraw when there is no terminal');
  assert.match(plain, /\n.*No\n/, 'the answer still lands on its own row');
});
