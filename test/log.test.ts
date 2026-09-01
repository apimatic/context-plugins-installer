import test from 'node:test';
import assert from 'node:assert';

import { log } from '../src/log.js';

test('width honours COLUMNS and stays within sane bounds', () => {
  const saved = process.env.COLUMNS;
  try {
    process.env.COLUMNS = '100';
    assert.equal(log.width(78), 78, 'clamped to the prose maximum');
    assert.equal(log.width(120), 99, 'uses the terminal when it is narrower than the maximum');

    process.env.COLUMNS = '20';
    assert.equal(log.width(120), 40, 'never narrower than 40');
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
  }
});

test('wrap breaks on whitespace and respects the indent', () => {
  const lines = log.wrap('one two three four five six seven', 6, 26);
  assert.ok(
    lines.every((l) => l.length <= 20),
    `expected every line <= 20 chars, got ${JSON.stringify(lines)}`,
  );
  assert.equal(lines.join(' '), 'one two three four five six seven', 'no words lost');
});

test('wrap keeps an unbreakable token intact rather than splitting a path', () => {
  const long = 'C:\\Users\\dev\\.context-plugins\\vscode\\a-very-long-plugin-name-here';
  const lines = log.wrap(`saved to ${long}`, 6, 40);
  assert.ok(
    lines.some((l) => l === long),
    'the path survives on its own line',
  );
});

test('truncate marks that it cut, and leaves short text alone', () => {
  assert.equal(log.truncate('abcdefghij', 8), 'abcde...');
  assert.equal(log.truncate('abc', 8), 'abc');
  assert.ok(log.truncate('abcdefghij', 8).length <= 8);
});

test('plural only adds the s when it should', () => {
  assert.equal(log.plural(1, 'plugin'), '1 plugin');
  assert.equal(log.plural(0, 'plugin'), '0 plugins');
  assert.equal(log.plural(2, 'plugin'), '2 plugins');
});

test('toAscii downgrades the punctuation marketplace descriptions actually use', () => {
  assert.equal(log.toAscii('a — b'), 'a - b');
  assert.equal(log.toAscii('an \u2018arg\u2019 and a \u201Cflag\u201D'), 'an \'arg\' and a "flag"');
  assert.equal(log.toAscii('wait\u2026'), 'wait...');
  assert.equal(log.toAscii('caf\u00e9'), 'cafe', 'diacritics stripped, not replaced');
});

test('toAscii preserves ANSI escapes, which are control codes not text', () => {
  const esc = String.fromCharCode(27);
  const colored = `${esc}[32mok${esc}[0m`;
  assert.equal(log.toAscii(colored), colored);
});

test('the check mark is only used where the console can render it', () => {
  // MARK is chosen once at load; assert it agrees with the detection either way.
  assert.equal(log.MARK, log.unicodeSupported() ? String.fromCharCode(0x2713) : '*');
});

test('toAscii maps the non-breaking space, which reads as an ordinary space', () => {
  const nbsp = String.fromCharCode(0x00a0);
  assert.equal(log.toAscii(`Stripe${nbsp}payments`), 'Stripe payments');
  assert.equal(log.toAscii('a b'), 'a b', 'an ordinary space is left alone');
});
