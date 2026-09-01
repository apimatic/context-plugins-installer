const state = { verbose: false, quiet: false };

/**
 * A check mark reads better than "OK", but legacy Windows consoles run cp437/
 * cp1252 and render it as mojibake. Use it only where the terminal is known to
 * cope, and fall back to ASCII everywhere else.
 */
export function unicodeSupported(): boolean {
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
// Closes the prompt flow drawn by prompt.ts, so its connector has somewhere to land.
// Its 3-column gutter matches that flow's, not the 6 of the prefixes above.
const GROUP_END = unicodeSupported() ? String.fromCharCode(0x2514) : '+';

/**
 * Terminal width, clamped: prose past ~78 columns is harder to read, not easier.
 * COLUMNS is honoured so redirected output and tests can pin a width.
 */
export function width(max = 78): number {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  return Math.max(40, Math.min(cols - 1, max));
}

const ASCII_MAP: Record<string, string> = {
  '—': '-', // em dash
  '–': '-', // en dash
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '•': '*',
  '→': '->',
  ' ': ' ',
};

/**
 * Marketplace descriptions are third-party text and routinely contain em dashes
 * and smart quotes. On a console that cannot render them they arrive as
 * mojibake, so downgrade to ASCII rather than print garbage.
 */
export function toAscii(text: string): string {
  let out = String(text).replace(/[—–‘’“”…•→ ]/g, (c) => ASCII_MAP[c] ?? c);
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip diacritics
  // ESC is kept: colour codes must survive, they are not text.
  return out.replace(/[^\x1b\x20-\x7e\t\r\n]/g, '?');
}

export const ascii = (text: string): string => (unicodeSupported() ? text : toAscii(text));

/** Wrap to the terminal, keeping long unbreakable tokens (paths, URLs) intact. */
export function wrap(text: string, indent = INDENT, max = width()): string[] {
  const room = Math.max(20, max - indent);
  const lines: string[] = [];
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

export function truncate(text: string, max: number): string {
  const clean = String(text).trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

export const plural = (n: number, word: string, suffix = 's'): string =>
  `${n} ${word}${n === 1 ? '' : suffix}`;

function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

const ESC = String.fromCharCode(27);
const paint = (code: string, text: string): string =>
  colorEnabled() ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const log = {
  setVerbose(v: unknown): void {
    state.verbose = Boolean(v);
  },
  setQuiet(v: unknown): void {
    state.quiet = Boolean(v);
  },
  get isVerbose(): boolean {
    return state.verbose;
  },
  get isQuiet(): boolean {
    return state.quiet;
  },
  banner(msg: string): void {
    if (!state.quiet) console.log(`\n${paint('36', ascii(msg))}`);
  },
  rule(): void {
    if (!state.quiet) console.log(paint('90', '-'.repeat(width())));
  },
  step(msg: string): void {
    if (!state.quiet) console.log(`\n${paint('1', ascii(msg))}`);
  },
  ok(msg: string): void {
    if (!state.quiet) console.log(`${paint('32', TICK)}${ascii(msg)}`);
  },
  /** Wrapped and indented, so long descriptions stay readable at any width. */
  info(msg: string): void {
    if (state.quiet) return;
    for (const line of wrap(ascii(msg))) console.log(paint('90', `      ${line}`));
  },
  warn(msg: string): void {
    if (state.quiet) return;
    const [head = '', ...tail] = wrap(ascii(msg));
    console.log(`${paint('33', BANG)}${head}`);
    for (const line of tail) console.log(paint('33', `      ${line}`));
  },
  /** The last line of the prompt flow: `└  <msg>`, closing the connector above it. */
  groupEnd(msg: string): void {
    if (state.quiet) return;
    const [head = '', ...tail] = wrap(ascii(msg), 3);
    console.log(`${paint('90', GROUP_END)}  ${head}`);
    for (const line of tail) console.log(`   ${line}`);
  },
  error(msg: string): void {
    const [head = '', ...tail] = wrap(ascii(msg));
    console.error(`${paint('31', CROSS)}${head}`);
    for (const line of tail) console.error(paint('31', `      ${line}`));
  },
  debug(msg: string): void {
    if (state.verbose && !state.quiet) console.log(paint('90', `  ..  ${ascii(msg)}`));
  },
  plain(msg = ''): void {
    if (!state.quiet) console.log(ascii(msg));
  },
  dim(msg: string): string {
    return paint('90', msg);
  },
  bold(msg: string): string {
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
