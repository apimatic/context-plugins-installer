'use strict';

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const log = require('./log');

/**
 * A prompt is only safe when a human is actually there. Piped input, CI, and
 * `npx … | tee` all have to fall through to non-interactive behaviour instead
 * of hanging forever on a question nobody can answer.
 */
function isInteractive(env = process.env) {
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
 * every glyph has an ASCII stand-in - the same rule log.js applies to its check mark.
 * Built from code points rather than pasted in, so the source stays ASCII and no
 * editor or console re-encoding can turn them into mojibake either.
 */
function glyphs(unicode = log.unicodeSupported()) {
  return unicode
    ? { step: String.fromCharCode(0x25c6), bar: String.fromCharCode(0x2502) } // diamond, bar
    : { step: '*', bar: '|' };
}

/**
 * `true`/`false` for an answer, `null` for anything else so the caller can re-ask.
 * Empty input takes the default, which is what makes a bare Enter work.
 */
function parseAnswer(input, defaultYes = true) {
  if (input === undefined || input === null) return defaultYes;
  const normalized = String(input).trim().toLowerCase();
  if (normalized === '') return defaultYes;
  if (YES.has(normalized)) return true;
  if (NO.has(normalized)) return false;
  return null;
}

// `input`/`out`/`unicode` default to the real terminal; they are overridable so the
// flow can be driven and inspected without one.
function createPrompter({ input = stdin, out = stdout, unicode } = {}) {
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
  const canRedraw = (line) => Boolean(out.isTTY) && line.length < (out.columns || 80);

  return {
    async confirm(question, defaultYes = true) {
      const hint = defaultYes ? '(Y/n)' : '(y/N)';
      const asked = `${g.step}  ${question} ${hint} `;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let answer;
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
        // The hint is noise once the decision is made: redraw the asked row as the
        // question alone, then put the decision under it as its own resolved step.
        if (canRedraw(asked + String(answer))) {
          out.write(UP_AND_CLEAR);
          out.write(`${log.dim(g.step)}  ${question}\n`);
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

module.exports = { isInteractive, createPrompter, glyphs, parseAnswer };
