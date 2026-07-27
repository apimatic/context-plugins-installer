'use strict';

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

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

function createPrompter() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\nCancelled.\n');
    process.exit(130);
  });

  return {
    async confirm(question, defaultYes = true) {
      const suffix = defaultYes ? '[Y/n]' : '[y/N]';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let answer;
        try {
          answer = await rl.question(`  ?   ${question} ${suffix} `);
        } catch {
          return defaultYes; // stdin closed mid-question
        }
        if (answer === undefined) return defaultYes;
        const normalized = answer.trim().toLowerCase();
        if (normalized === '') return defaultYes;
        if (YES.has(normalized)) return true;
        if (NO.has(normalized)) return false;
        stdout.write('      Please answer y or n.\n');
      }
      return defaultYes;
    },
    close() {
      rl.close();
    },
  };
}

module.exports = { isInteractive, createPrompter };
