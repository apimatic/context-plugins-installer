import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { log } from './log.js';
import type { Env, Prompter } from './types.js';

export function isInteractive(env: Env = process.env): boolean {
  if (env.CI) return false;
  if (env.CP_NO_INPUT) return false;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

const ESC = String.fromCharCode(27);
const UP_AND_CLEAR = `${ESC}[1A${ESC}[2K\r`;

// Legacy Windows consoles render box drawing as mojibake, so every glyph has an
// ASCII stand-in. Built from code points so the source itself stays ASCII.
export function glyphs(unicode: boolean = log.unicodeSupported()): { step: string; bar: string } {
  return unicode
    ? { step: String.fromCharCode(0x25c6), bar: String.fromCharCode(0x2502) } // diamond, bar
    : { step: '*', bar: '|' };
}

/** null for anything that is not an answer, so the caller can re-ask. */
export function parseAnswer(input: unknown, defaultYes = true): boolean | null {
  if (input === undefined || input === null) return defaultYes;
  const normalized = String(input).trim().toLowerCase();
  if (normalized === '') return defaultYes;
  if (YES.has(normalized)) return true;
  if (NO.has(normalized)) return false;
  return null;
}

export type PromptOutput = NodeJS.WritableStream & { isTTY?: boolean; columns?: number };

export interface PrompterOptions {
  input?: NodeJS.ReadableStream;
  out?: PromptOutput;
  unicode?: boolean;
}

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

  // Past the terminal width the row may have wrapped, and the cursor arithmetic
  // would clear the wrong line.
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
        // Redraw the row without the keystroke; the answer gets its own row below.
        if (canRedraw(asked + String(answer))) {
          out.write(UP_AND_CLEAR);
          out.write(`${log.dim(g.step)}  ${question} ${hint}\n`);
        } else if (!out.isTTY) {
          // Nothing echoes the user's Enter off a TTY.
          out.write('\n');
        }
        out.write(`${log.dim(g.bar)}  ${log.dim(parsed ? 'Yes' : 'No')}\n`);
        return parsed;
      }
      return defaultYes;
    },
    close() {
      out.write(`${log.dim(g.bar)}\n`);
      rl.close();
    },
  };
}
