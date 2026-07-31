'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { glyphs, parseAnswer, isInteractive } = require('../src/prompt');

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

test('CI and CP_NO_INPUT both force non-interactive', () => {
  assert.equal(isInteractive({ CI: '1' }), false);
  assert.equal(isInteractive({ CP_NO_INPUT: '1' }), false);
});
