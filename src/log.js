'use strict';

// ASCII-only output on purpose: Windows consoles still default to cp437/cp1252,
// where box-drawing characters and em-dashes turn into mojibake.

const state = { verbose: false, quiet: false };

function colorEnabled() {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

const ESC = String.fromCharCode(27);
const paint = (code, text) => (colorEnabled() ? `${ESC}[${code}m${text}${ESC}[0m` : text);

const log = {
  setVerbose(v) {
    state.verbose = Boolean(v);
  },
  setQuiet(v) {
    state.quiet = Boolean(v);
  },
  get isVerbose() {
    return state.verbose;
  },
  banner(msg) {
    if (!state.quiet) console.log(`\n${paint('36', msg)}`);
  },
  rule() {
    if (!state.quiet) console.log(paint('90', '-'.repeat(64)));
  },
  step(msg) {
    if (!state.quiet) console.log(`\n${paint('1', msg)}`);
  },
  ok(msg) {
    if (!state.quiet) console.log(`${paint('32', '  OK  ')}${msg}`);
  },
  info(msg) {
    if (!state.quiet) console.log(paint('90', `      ${msg}`));
  },
  warn(msg) {
    if (!state.quiet) console.log(`${paint('33', '  !!  ')}${msg}`);
  },
  error(msg) {
    console.error(`${paint('31', '  XX  ')}${msg}`);
  },
  debug(msg) {
    if (state.verbose && !state.quiet) console.log(paint('90', `  ..  ${msg}`));
  },
  plain(msg = '') {
    if (!state.quiet) console.log(msg);
  },
};

module.exports = log;
