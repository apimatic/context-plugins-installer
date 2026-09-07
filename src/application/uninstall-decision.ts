import {
  NAMES,
  everyEditor,
  isHarnessName,
  titlesOf,
  type HarnessName,
  type UninstallOutcome,
} from '../types/harness.js';
import { rowShape } from '../types/installed-record.js';
import type { SummaryLine, UninstallDecision, UninstallFacts } from '../types/uninstall.js';

// Pure: facts in, a decision and its prose out. Four review rounds each found
// another combination of row shape, outcome and `--force` where the record and
// the summary disagreed, which is why both come from one function over one
// input, and why the test walks the whole space rather than a few cases.

/**
 * What to write and what to say, from one set of facts so the two cannot
 * disagree. `test/application/uninstall-decision.test.ts` walks the whole state
 * space it is defined over.
 */
export function decideUninstall({
  recorded,
  outcomes,
  want,
  force,
}: UninstallFacts): UninstallDecision {
  const of = (...kinds: UninstallOutcome[]): HarnessName[] =>
    [...outcomes].filter(([, o]) => kinds.includes(o)).map(([n]) => n);

  const row = rowShape(recorded);
  const listed: unknown[] = Array.isArray(recorded?.targets) ? recorded.targets : [];
  const onRow = (names: HarnessName[]): HarnessName[] => names.filter((n) => listed.includes(n));

  // `absent` clears too: the row is what drifted, not the run.
  const clear = force ? [...outcomes.keys()] : of('removed', 'absent');
  // Foreign target names stay on the record for whichever tool wrote them.
  const remaining = listed.filter((t) => !clear.some((c) => c === t));

  // A row that can only be dropped or kept whole needs a higher bar: `targets: []`
  // reads as "every harness", so every harness must have answered.
  const askedEveryEditor = NAMES.every((n) => want.includes(n));
  const answeredAll = of('failed', 'skipped').length === 0;
  let dropWhole = false;
  if (row === 'foreign') dropWhole = force;
  else if (row === 'unusable') dropWhole = force || (askedEveryEditor && answeredAll);

  // A shortened row goes when nothing is left on it - or, under `--force`, when
  // nothing this build can act on is left, since otherwise clearing it would
  // take a second identical `--force`.
  const spent = row === 'list' && (force ? !remaining.some(isHarnessName) : remaining.length === 0);
  const rowGone = Boolean(recorded) && (spent || dropWhole);
  const shorten = Boolean(recorded) && row === 'list' && remaining.length < listed.length;

  return {
    removed: of('removed'),
    failed: of('failed'),
    cleared: onRow(of('absent')),
    // Only what came off because `--force` said so. An editor that removed the
    // plugin, or established there was nothing to remove, confirmed it.
    forced: force ? onRow(of('skipped', 'failed')) : [],
    // Still on the row afterwards, whether unsettled or never asked.
    stuck: rowGone ? [] : remaining.filter(isHarnessName),
    // Named, never silent: this is another tool's data going out with the row.
    droppedUnknown: rowGone ? listed.filter((t) => !isHarnessName(t)).map(String) : [],
    write: rowGone ? 'remove' : shorten ? 'shorten' : 'none',
    targets: remaining,
    rowLeft:
      !recorded || rowGone
        ? 'none'
        : rowShape({ ...recorded, targets: row === 'list' ? remaining : recorded.targets }),
  };
}

/** One line per thing that happened, and nothing that did not. */
export function uninstallLines(
  { removed, cleared, forced, failed, stuck, rowLeft, write, droppedUnknown }: UninstallDecision,
  { plugin, bin }: { plugin: string; bin: string },
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (removed.length) lines.push({ level: 'ok', text: `Uninstalled from: ${titlesOf(removed)}` });
  if (cleared.length) {
    lines.push({
      level: 'ok',
      text: `Nothing was installed in ${titlesOf(cleared)} - cleared that from the record.`,
    });
  }
  if (forced.length) {
    lines.push({
      level: 'warn',
      text: `Dropped from the record without confirming removal: ${titlesOf(forced)}`,
    });
  }
  // Gone for a reason none of the lines above covers.
  if (write === 'remove' && !removed.length && !cleared.length && !forced.length) {
    lines.push({ level: 'ok', text: `Dropped the stale record for '${plugin}'.` });
  }
  if (droppedUnknown.length) {
    lines.push({
      level: 'warn',
      text: `Dropped target name(s) this version cannot act on: ${droppedUnknown.join(', ')}`,
    });
  }

  // Unmentioned, such a row is filed under `ignored` and fails every `update`.
  const stranded = rowLeft === 'foreign' || rowLeft === 'unusable';
  // The stuck targets, never the run's `--targets`: it cannot widen the ask.
  const scope = stuck.length ? ` --targets ${stuck.join(',')}` : '';
  const forceLine = `\`${bin} uninstall ${plugin}${scope} --force\` drops it without confirming.`;
  if (stranded) {
    lines.push({
      level: 'warn',
      text:
        rowLeft === 'foreign'
          ? `The record for '${plugin}' has a target list this version cannot read.`
          : `The record for '${plugin}' names no editor to remove from.`,
    });
    lines.push({ level: 'info', text: forceLine });
  } else if (stuck.length) {
    lines.push({
      level: 'info',
      text: `Still recorded for ${titlesOf(stuck)} - nothing here could confirm otherwise.`,
    });
    lines.push({ level: 'info', text: forceLine });
  }

  // Only the right question when nothing happened and nothing else was said; a
  // failure is the thrown error's to report.
  if (!lines.length && !failed.length) {
    lines.push({ level: 'warn', text: nothingChanged() });
  }
  return lines;
}

export const nothingChanged = (): string => `Nothing was changed. Are ${everyEditor()} installed?`;
