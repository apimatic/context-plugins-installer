'use strict';

const state = { verbose: false, quiet: false };

/**
 * A check mark reads better than "OK", but legacy Windows consoles run cp437/
 * cp1252 and render it as mojibake. Use it only where the terminal is known to
 * cope, and fall back to ASCII everywhere else.
 */
function unicodeSupported() {
  if (process.platform !== 'win32') return process.env.TERM !== 'linux';
  return Boolean(
    process.env.WT_SESSION || // Windows Terminal
      process.env.TERMINUS_SUBLIME ||
      process.env.ConEmuTask === '{cmd::Cmd}' ||
      process.env.TERM_PROGRAM === 'vscode' ||
      process.env.TERM === 'xterm-256color' ||
      process.env.TERM === 'alacritty',
  );
}

// Every prefix is padded to the same width so continuation lines line up.
const TICK = unicodeSupported() ? `  ${String.fromCharCode(0x2713)}   ` : '  OK  ';
const BANG = '  !!  ';
const CROSS = '  XX  ';

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
    if (!state.quiet) console.log(`${paint('32', TICK)}${msg}`);
  },
  info(msg) {
    if (!state.quiet) console.log(paint('90', `      ${msg}`));
  },
  warn(msg) {
    if (!state.quiet) console.log(`${paint('33', BANG)}${msg}`);
  },
  error(msg) {
    console.error(`${paint('31', CROSS)}${msg}`);
  },
  debug(msg) {
    if (state.verbose && !state.quiet) console.log(paint('90', `  ..  ${msg}`));
  },
  plain(msg = '') {
    if (!state.quiet) console.log(msg);
  },
};

module.exports = log;
