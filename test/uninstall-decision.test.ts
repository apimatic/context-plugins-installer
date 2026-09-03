import test from 'node:test';
import assert from 'node:assert';

import { NAMES, byName, isHarnessName } from '../src/harness/index.js';
import { decideUninstall, uninstallLines } from '../src/install.js';
import type { HarnessName, UninstallOutcome } from '../src/types.js';

/**
 * Four review rounds each found another combination of row shape, outcomes and
 * `--force` where the record and the summary disagreed, or where the prose
 * asserted something no editor had established. Every one of them was inside a
 * space small enough to walk, so this walks it: every row shape, every outcome
 * for every editor (including "not asked"), with and without `--force`. The
 * assertions are the invariants, not the cases - a new bad combination is a
 * failing test here rather than a finding later.
 */

const OUTCOMES: UninstallOutcome[] = ['removed', 'absent', 'skipped', 'failed'];
/** null is "this run never asked that editor". */
type Answer = UninstallOutcome | null;
const ANSWERS: Answer[] = [null, ...OUTCOMES];

const ROWS: { label: string; targets?: unknown }[] = [
  { label: 'no targets key' },
  { label: 'targets: []', targets: [] },
  { label: 'targets: null', targets: null },
  { label: 'targets: {}', targets: { claude: {} } },
  { label: 'targets: "cursor"', targets: 'cursor' },
  { label: 'only unknown names', targets: ['zed'] },
  { label: 'one known name', targets: ['cursor'] },
  { label: 'every known name', targets: [...NAMES] },
  { label: 'known plus unknown', targets: ['cursor', 'zed'] },
];

interface Case {
  label: string;
  recorded: Record<string, unknown> | null;
  outcomes: Map<HarnessName, UninstallOutcome>;
  want: HarnessName[];
  force: boolean;
}

function* cases(): Generator<Case> {
  for (const force of [false, true]) {
    for (const row of ROWS) {
      const recorded: Record<string, unknown> = { plugin: 'p', repo: 'o/r', marketplace: 'm' };
      if ('targets' in row) recorded.targets = row.targets;
      for (const answers of assignments()) {
        const want: HarnessName[] = [];
        const outcomes = new Map<HarnessName, UninstallOutcome>();
        NAMES.forEach((name, i) => {
          const answer = answers[i];
          if (!answer) return;
          want.push(name);
          outcomes.set(name, answer);
        });
        const asked = want.length ? want.join('+') : 'none';
        yield {
          label: `${row.label} | asked ${asked} | ${[...outcomes.values()].join(',') || '-'} | force=${force}`,
          recorded,
          outcomes,
          want,
          force,
        };
      }
    }
    // The same outcome sweep against no row at all.
    for (const answers of assignments()) {
      const want: HarnessName[] = [];
      const outcomes = new Map<HarnessName, UninstallOutcome>();
      NAMES.forEach((name, i) => {
        if (!answers[i]) return;
        want.push(name);
        outcomes.set(name, answers[i] as UninstallOutcome);
      });
      yield {
        label: `no row | ${[...outcomes.values()].join(',') || '-'} | force=${force}`,
        recorded: null,
        outcomes,
        want,
        force,
      };
    }
  }
}

/** Every answer for every editor, "not asked" included. */
function* assignments(): Generator<Answer[]> {
  const total = ANSWERS.length ** NAMES.length;
  for (let n = 0; n < total; n += 1) {
    const out: Answer[] = [];
    let rest = n;
    for (let i = 0; i < NAMES.length; i += 1) {
      out.push(ANSWERS[rest % ANSWERS.length]);
      rest = Math.floor(rest / ANSWERS.length);
    }
    yield out;
  }
}

const title = (n: HarnessName): string => byName(n).title;
/** What the row's `targets` reads as after the decision is applied. */
function targetsAfter(c: Case, d: ReturnType<typeof decideUninstall>): unknown[] | 'gone' | 'same' {
  if (d.write === 'remove') return 'gone';
  if (d.write === 'shorten') return d.targets;
  return 'same';
}

test('the whole uninstall state space holds its invariants', () => {
  let seen = 0;
  for (const c of cases()) {
    seen += 1;
    const d = decideUninstall(c);
    const lines = uninstallLines(d, { plugin: 'p', bin: 'cp' });
    const text = lines.map((l) => l.text).join(' | ');
    const where = `${c.label}\n  decision: ${JSON.stringify(d)}\n  said: ${text}`;

    // ---- 1. Nothing is claimed that did not happen -------------------------
    for (const n of d.removed) {
      assert.equal(c.outcomes.get(n), 'removed', `claimed a removal that did not happen\n${where}`);
    }
    for (const n of d.failed) {
      assert.equal(c.outcomes.get(n), 'failed', `claimed a failure that did not happen\n${where}`);
    }

    // ---- 2. A target only leaves the record on an answer, or on --force ----
    const before: unknown[] = Array.isArray(c.recorded?.targets) ? c.recorded.targets : [];
    const after = targetsAfter(c, d);
    const left =
      after === 'gone' ? before : after === 'same' ? [] : before.filter((t) => !after.includes(t));
    for (const t of left) {
      if (!isHarnessName(t)) {
        assert.ok(c.force, `dropped a foreign target without --force\n  ${String(t)}\n${where}`);
        continue;
      }
      const answer = c.outcomes.get(t);
      assert.ok(
        c.force || answer === 'removed' || answer === 'absent',
        `dropped ${t} on a ${answer ?? 'question never asked'}\n${where}`,
      );
    }

    // ---- 3. A dropped foreign name is always named ------------------------
    for (const t of d.droppedUnknown) {
      assert.ok(text.includes(t), `dropped the foreign target '${t}' without saying so\n${where}`);
    }

    // ---- 4. The three reports are disjoint --------------------------------
    for (const n of d.cleared) {
      assert.ok(!d.stuck.includes(n), `${n} is both cleared and stuck\n${where}`);
      assert.ok(!d.forced.includes(n), `${n} is both cleared and forced\n${where}`);
    }
    for (const n of d.forced) {
      assert.ok(!d.stuck.includes(n), `${n} is both forced and stuck\n${where}`);
    }

    // ---- 4. `stuck` is exactly what a reader could still act on -----------
    const stillOnRow = after === 'gone' ? [] : after === 'same' ? before : after;
    assert.deepEqual(
      [...d.stuck].sort(),
      stillOnRow.filter(isHarnessName).sort(),
      `stuck does not match the row as written\n${where}`,
    );

    // ---- 5. "Nothing was changed" only when nothing was ------------------
    const quiet = text.includes('Nothing was changed');
    if (quiet) {
      assert.equal(d.write, 'none', `said nothing changed after a ${d.write}\n${where}`);
      assert.equal(d.removed.length, 0, `said nothing changed after a removal\n${where}`);
      assert.equal(lines.length, 1, `"nothing changed" stood beside other claims\n${where}`);
    }

    // ---- 6. A row nothing can act on is never left in silence ------------
    // This is the bug every round found in a new shape: `read()` files such a
    // row under `ignored`, so `update` fails on it forever.
    const strandedAfter = after !== 'gone' && (d.rowLeft === 'foreign' || d.rowLeft === 'unusable');
    if (strandedAfter) {
      assert.ok(
        text.includes('--force'),
        `left a row this build cannot act on without naming --force\n${where}`,
      );
    }

    // ---- 7. Every line is about this run ----------------------------------
    // No editor may be named as removed-from unless it was, and no editor the
    // run never asked may appear in any claim about what happened.
    for (const n of NAMES) {
      if (c.outcomes.has(n)) continue;
      assert.ok(
        !d.removed.includes(n) && !d.cleared.includes(n) && !d.failed.includes(n),
        `${title(n)} was never asked, yet appears in a claim\n${where}`,
      );
    }

    // ---- 8. Silence is only allowed when the thrown error will speak -------
    assert.ok(
      lines.length > 0 || d.failed.length > 0,
      `said nothing at all, and nothing failed to explain it\n${where}`,
    );
  }

  // 2 force values x (9 rows + 1 no-row) x 5^3 answers
  assert.equal(seen, 2 * 10 * ANSWERS.length ** NAMES.length, 'the sweep covered the space');
});

// The claim the whole branch exists to make, over the same space: a row this
// build can READ never survives a run that answered for all of it. A row it
// cannot read belongs to whoever wrote it and needs `--force` by design -
// invariant 6 above is what proves the user is told so.
test('a readable row every editor answered for is never left behind', () => {
  let checked = 0;
  for (const c of cases()) {
    const answered =
      c.want.length === NAMES.length &&
      [...c.outcomes.values()].every((o) => o === 'removed' || o === 'absent');
    if (!answered || !c.recorded) continue;
    const before: unknown[] = Array.isArray(c.recorded.targets) ? c.recorded.targets : [];
    const readable = before.length > 0 && before.every(isHarnessName);
    if (!readable && !c.force) continue;
    // A row with no target list at all is the `unusable` shape, whose rule is
    // its own; this invariant is about rows that name editors.
    if (!Array.isArray(c.recorded.targets) || before.length === 0) continue;
    checked += 1;
    const d = decideUninstall(c);
    assert.equal(
      d.write,
      'remove',
      `every editor answered, yet the row survived\n  ${c.label}\n  ${JSON.stringify(d)}`,
    );
  }
  assert.ok(checked > 0, 'the invariant was actually exercised');
});
