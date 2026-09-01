import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { log } from './log.js';
import type { Env, Prompter } from './types.js';

/**
 * A prompt is only safe when a human is actually there. Piped input, CI, and
 * `npx … | tee` all have to fall through to non-interactive behaviour instead
 * of hanging forever on a question nobody can answer.
 */
export function isInteractive(env: Env = process.env): boolean {
  if (env.CI) return false;
  if (env.CP_NO_INPUT) return false;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

const ESC = String.fromCharCode(27);
const UP_AND_CLEAR = `${ESC}[1A${ESC}[2K\r`;

/**
 * The questions in one run are a single flow, not a handful of unrelated lines, so
 * they are drawn as one: the glyph sits against its text with no floating gap, and a
 * connector runs from each answer down to the next question and on to whatever the
 * caller prints last (see `log.groupEnd`).
 *
 * Legacy Windows consoles run cp437/cp1252 and render box drawing as mojibake, so
 * every glyph has an ASCII stand-in - the same rule log.ts applies to its check mark.
 * Built from code points rather than pasted in, so the source stays ASCII and no
 * editor or console re-encoding can turn them into mojibake either.
 */
export function glyphs(unicode: boolean = log.unicodeSupported()): { step: string; bar: string } {
  return unicode
    ? { step: String.fromCharCode(0x25c6), bar: String.fromCharCode(0x2502) } // diamond, bar
    : { step: '*', bar: '|' };
}

/**
 * `true`/`false` for an answer, `null` for anything else so the caller can re-ask.
 * Empty input takes the default, which is what makes a bare Enter work.
 */
export function parseAnswer(input: unknown, defaultYes = true): boolean | null {
  if (input === undefined || input === null) return defaultYes;
  const normalized = String(input).trim().toLowerCase();
  if (normalized === '') return defaultYes;
  if (YES.has(normalized)) return true;
  if (NO.has(normalized)) return false;
  return null;
}

/** Where the prompt draws: the real terminal, or a stream a test can inspect. */
export type PromptOutput = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };

export interface PrompterOptions {
  input?: NodeJS.ReadableStream;
  out?: PromptOutput;
  unicode?: boolean;
}

// `input`/`out`/`unicode` default to the real terminal; they are overridable so the
// flow can be driven and inspected without one.
export function createPrompter({
  input = stdin,
  out = stdout,
  unicode,
}: PrompterOptions = {}): Prompter {
  const g = glyphs(unicode);
  const rl = readline.createInterface({ input, output: out });
  rl.on('SIGINT', () => {
    rl.close();
    out.write(`\n${g.bar}  Cancelled.\n`);
    process.exit(130);
  });

  // Redrawing means clearing the row the user just typed on. Only attempt it on a
  // TTY, and only when that row cannot have wrapped - past the terminal width the
  // cursor arithmetic would clear the wrong line and eat real output.
  const canRedraw = (line: string): boolean =>
    Boolean(out.isTTY) && line.length < (out.columns || 80);

  return {
    async confirm(question, defaultYes = true) {
      const hint = defaultYes ? '(Y/n)' : '(y/N)';
      const asked = `${g.step}  ${question} ${hint} `;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let answer: string;
        try {
          answer = await rl.question(asked);
        } catch {
          return defaultYes; // stdin closed mid-question
        }
        const parsed = parseAnswer(answer, defaultYes);
        if (parsed === null) {
          out.write(`${log.dim(g.bar)}  Please answer yes or no.\n`);
          continue;
        }
        // The keystroke goes, the question and its hint stay: the row is redrawn as it
        // was asked, and the decision lands under it as its own resolved step. Reading
        // back `(Y/n) y` next to `Yes` is the same answer twice.
        if (canRedraw(asked + String(answer))) {
          out.write(UP_AND_CLEAR);
          out.write(`${log.dim(g.step)}  ${question} ${hint}\n`);
        } else if (!out.isTTY) {
          // A TTY echoes the user's Enter, so the cursor is already on a fresh row.
          // Nothing echoes off one, so the answer would land on the asked row.
          out.write('\n');
        }
        out.write(`${log.dim(g.bar)}  ${log.dim(parsed ? 'Yes' : 'No')}\n`);
        return parsed;
      }
      return defaultYes;
    },
    close() {
      out.write(`${log.dim(g.bar)}\n`); // connector into the caller's closing line
      rl.close();
    },
  };
}
