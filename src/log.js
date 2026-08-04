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
const INDENT = 6;
const TICK = unicodeSupported() ? `  ${String.fromCharCode(0x2713)}   ` : '  OK  ';
const BANG = '  !!  ';
const CROSS = '  XX  ';
const MARK = unicodeSupported() ? String.fromCharCode(0x2713) : '*';

/**
 * Terminal width, clamped: prose past ~78 columns is harder to read, not easier.
 * COLUMNS is honoured so redirected output and tests can pin a width.
 */
function width(max = 78) {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  return Math.max(40, Math.min(cols - 1, max));
}

const ASCII_MAP = {
  '—': '-', // em dash
  '–': '-', // en dash
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '•': '*',
  '→': '->',
  ' ': ' ',
};

/**
 * Marketplace descriptions are third-party text and routinely contain em dashes
 * and smart quotes. On a console that cannot render them they arrive as
 * mojibake, so downgrade to ASCII rather than print garbage.
 */
function toAscii(text) {
  let out = String(text).replace(/[—–‘’“”…•→ ]/g, (c) => ASCII_MAP[c]);
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip diacritics
  // ESC is kept: colour codes must survive, they are not text.
  return out.replace(/[^\x1b\x20-\x7e\t\r\n]/g, '?');
}

const ascii = (text) => (unicodeSupported() ? text : toAscii(text));

/** Wrap to the terminal, keeping long unbreakable tokens (paths, URLs) intact. */
function wrap(text, indent = INDENT, max = width()) {
  const room = Math.max(20, max - indent);
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= room) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function truncate(text, max) {
  const clean = String(text).trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

const plural = (n, word, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`;

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
  get isQuiet() {
    return state.quiet;
  },
  banner(msg) {
    if (!state.quiet) console.log(`\n${paint('36', ascii(msg))}`);
  },
  rule() {
    if (!state.quiet) console.log(paint('90', '-'.repeat(width())));
  },
  step(msg) {
    if (!state.quiet) console.log(`\n${paint('1', ascii(msg))}`);
  },
  ok(msg) {
    if (!state.quiet) console.log(`${paint('32', TICK)}${ascii(msg)}`);
  },
  /** Wrapped and indented, so long descriptions stay readable at any width. */
  info(msg) {
    if (state.quiet) return;
    for (const line of wrap(ascii(msg))) console.log(paint('90', `      ${line}`));
  },
  warn(msg) {
    if (state.quiet) return;
    const [first, ...rest] = wrap(ascii(msg));
    console.log(`${paint('33', BANG)}${first}`);
    for (const line of rest) console.log(paint('33', `      ${line}`));
  },
  /**
   * The shape of ok() in warning colour: a per-item status line that is neither
   * a success nor a failure. Unlike warn() it does not wrap, because these lines
   * are padded into columns and wrapping would collapse the padding.
   */
  note(msg) {
    if (!state.quiet) console.log(`${paint('33', BANG)}${ascii(msg)}`);
  },
  error(msg) {
    const [first, ...rest] = wrap(ascii(msg));
    console.error(`${paint('31', CROSS)}${first}`);
    for (const line of rest) console.error(paint('31', `      ${line}`));
  },
  debug(msg) {
    if (state.verbose && !state.quiet) console.log(paint('90', `  ..  ${ascii(msg)}`));
  },
  plain(msg = '') {
    if (!state.quiet) console.log(ascii(msg));
  },
  dim(msg) {
    return paint('90', msg);
  },
  bold(msg) {
    return paint('1', msg);
  },
  MARK,
  width,
  wrap,
  truncate,
  plural,
  ascii,
  toAscii,
  unicodeSupported,
};

module.exports = log;
