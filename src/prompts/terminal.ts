const state = { verbose: false, quiet: false };

// Legacy Windows consoles (cp437/cp1252) render the check mark as mojibake.
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
// Closes the prompt flow drawn by prompt.ts; its 3-column gutter matches that flow.
const GROUP_END = unicodeSupported() ? String.fromCharCode(0x2514) : '+';

/** Terminal width clamped to a readable prose width; COLUMNS lets tests pin it. */
export function width(max = 78): number {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  return Math.max(40, Math.min(cols - 1, max));
}

// Written as an escape at both sites below: a literal U+00A0 is invisible, and
// the port lost it once already to an editor normalising it to a plain space.
const NBSP = String.fromCharCode(0xa0);

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
  [NBSP]: ' ',
};

// Marketplace descriptions are third-party text full of em dashes and smart
// quotes, which a console that cannot render them shows as mojibake.
export function toAscii(text: string): string {
  let out = String(text).replace(/[—–‘’“”…•→\u00a0]/g, (c) => ASCII_MAP[c] ?? c);
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip diacritics
  // ESC is kept: colour codes must survive.
  return out.replace(/[^\x1b\x20-\x7e\t\r\n]/g, '?');
}

export const ascii = (text: string): string => (unicodeSupported() ? text : toAscii(text));

/** Wraps on whitespace, keeping unbreakable tokens (paths, URLs) intact. */
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

function emitWarn(emit: (line: string) => void, msg: string): void {
  if (state.quiet) return;
  const [head = '', ...tail] = wrap(ascii(msg));
  emit(`${paint('33', BANG)}${head}`);
  for (const line of tail) emit(paint('33', `      ${line}`));
}

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
  info(msg: string): void {
    if (state.quiet) return;
    for (const line of wrap(ascii(msg))) console.log(paint('90', `      ${line}`));
  },
  warn(msg: string): void {
    emitWarn(console.log, msg);
  },
  /** For warnings that must not land in a --json payload another tool parses. */
  warnStderr(msg: string): void {
    emitWarn(console.error, msg);
  },
  /**
   * A disclosure, not progress: on stderr so a payload stays clean, and shown
   * under --quiet too, because the reader has to be told what is collected.
   */
  notice(msg: string, { verbatim = false } = {}): void {
    const lines = verbatim ? [ascii(msg)] : wrap(ascii(msg));
    for (const line of lines) console.error(paint('90', `      ${line}`));
  },
  /** The last line of the prompt flow, closing the connector above it. */
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
  // On stderr: --verbose must stay composable with the --json output modes.
  debug(msg: string): void {
    if (state.verbose && !state.quiet) console.error(paint('90', `  ..  ${ascii(msg)}`));
  },
  plain(msg = ''): void {
    if (!state.quiet) console.log(ascii(msg));
  },
  /**
   * Machine-readable output: written verbatim, because ascii() would rewrite the
   * payload's own content on a legacy console, and --quiet asks for less progress
   * detail, not for the thing the caller ran --json to get.
   */
  payload(text: string): void {
    console.log(text);
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
