import { createPrompter } from './prompter.js';
import type { Brand } from '../types/brand.js';
import type { PluginSource, UntrustedSource } from '../types/plugin-source.js';
import {
  NAMES,
  TITLES,
  everyEditor,
  nothingChanged,
  titlesOf,
  type Harness,
  type HarnessListener,
  type HarnessName,
} from '../types/harness.js';
import { format as f } from './format.js';
import { harnessListener } from './harness/index.js';
import { log } from './terminal.js';

/**
 * Whoever answers "install into X?" - an injected confirm, or a real prompter.
 * `'cancelled'` is the interrupt travelling back as an answer, which only the
 * real prompter produces; a test's confirm answers yes or no.
 */
export type Ask = (
  question: string,
  defaultYes: boolean,
) => boolean | 'cancelled' | Promise<boolean | 'cancelled'>;

export class InstallPrompts {
  /**
   * Whether the interactive flow was drawn. The connector under it has to be
   * closed by whatever line comes next, which is why this is state here rather
   * than something the action has to remember to pass back.
   */
  private drewFlow = false;

  constructor(
    private readonly home?: string,
    private readonly confirm?: Ask,
  ) {}

  readonly harnessListener: HarnessListener = (event) => harnessListener(this.home)(event);

  /** Where the plugin is coming from, as the banner says it. */
  private origin(brand: Brand, ref: string | null, source: PluginSource): string {
    if (source.kind !== 'marketplace') return this.where(source);
    return ref && ref !== 'main' ? `${brand.label} (${ref})` : brand.label;
  }

  /**
   * A source the user named, as they would recognise it: a directory shortened
   * against home, or the repository, folder and ref that were asked for.
   */
  private where(source: UntrustedSource): string {
    return source.kind === 'local' ? f.path(source.dir, this.home) : source.toString();
  }

  intro(
    plugin: string,
    brand: Brand,
    ref: string | null,
    marketplace: string,
    about: string,
    source: PluginSource,
  ): void {
    log.banner(`Installing '${plugin}' from ${this.origin(brand, ref, source)}`);
    log.debug(
      source.kind === 'marketplace'
        ? `source: ${brand.repo}@${ref}, marketplace: ${marketplace}`
        : `source: ${source}, marketplace: ${marketplace}`,
    );
    if (about) log.info(about);
    log.rule();
    log.step('[Harnesses]');
  }

  /**
   * Whether to install from a source this program was not shipped pointing at.
   * Asked before anything is fetched or copied, because a plugin from an
   * arbitrary directory can carry hooks and MCP servers that run commands.
   *
   * `assumed` covers both ways of having already answered - `--yes`, and a shell
   * with nobody in it. The line is still printed in that case: the source is
   * exactly what a run doing this unattended should say out loud.
   */
  async confirmSource(source: UntrustedSource, assumed: boolean): Promise<boolean | 'cancelled'> {
    const where = this.where(source);
    log.warn(`This installs a plugin from ${where}, not from ${TITLES.claude}'s marketplace.`);
    log.info('A plugin can run commands through its hooks and MCP servers.');
    if (assumed) return true;
    const question = 'Install from this source?';
    if (this.confirm) return this.confirm(question, false);
    const prompter = createPrompter();
    try {
      return await prompter.confirm(question, false);
    } finally {
      prompter.close();
    }
  }

  /**
   * A `--ref` the spec itself overrode. Said rather than swallowed: a flag
   * that quietly did nothing is the one thing that reads as the user having
   * chosen what happened.
   */
  refIgnored(flag: string, used: string): void {
    log.warn(`Using ref '${used}' from the plugin spec - --ref ${flag} was not used.`);
  }

  /** The source was declined, which is not the same as choosing no editor. */
  nothingTrusted(): void {
    log.plain('');
    log.warn('Not installed - the source was not confirmed.');
  }

  notInstalled(harness: Harness, opts?: { home?: string }): void {
    log.info(
      `${harness.title} is not installed (looked in ${f.path(harness.location(opts), this.home)}).`,
    );
  }

  continuingWith(available: readonly HarnessName[]): void {
    log.info(`Continuing with ${titlesOf(available)}.`);
  }

  /**
   * Nobody to ask, so every detected editor is taken rather than the run
   * hanging - and that is worth a line: silence would read as the user having
   * chosen them.
   */
  nobodyToAsk(): void {
    log.info('Non-interactive shell - using every detected harness (--targets to choose).');
  }

  /**
   * Whether anyone is here to answer. Asked by the action, because the decision
   * is application's and the TTY is infrastructure's - but the answerer itself
   * lives here and nowhere else, which is what keeps the two from disagreeing.
   */
  hasAnswerer(): boolean {
    return Boolean(this.confirm);
  }

  /** One question per detected editor, through whoever is answering. */
  async askHarnesses(available: readonly HarnessName[]): Promise<HarnessName[] | 'cancelled'> {
    if (this.confirm) return this.each(available, this.confirm);
    this.drewFlow = true;
    const prompter = createPrompter();
    try {
      return await this.each(available, (question, def) => prompter.confirm(question, def));
    } finally {
      prompter.close();
    }
  }

  private async each(
    available: readonly HarnessName[],
    ask: Ask,
  ): Promise<HarnessName[] | 'cancelled'> {
    const chosen: HarnessName[] = [];
    for (const name of available) {
      const answer = await ask(`Install into ${TITLES[name]}?`, true);
      // Never tested for truth: `'cancelled'` is a string, and a truthy one.
      if (answer === 'cancelled') return 'cancelled';
      if (answer) chosen.push(name);
    }
    return chosen;
  }

  /** Closes the prompt flow's connector when one was drawn. */
  private closeFlow(msg: string): void {
    if (this.drewFlow) log.groupEnd(msg);
    else log.info(msg);
  }

  nothingChosen(): void {
    if (this.drewFlow) {
      log.groupEnd('No harness selected - nothing was installed.');
      return;
    }
    log.plain('');
    log.warn('No harness selected - nothing was installed.');
  }

  installingInto(want: readonly HarnessName[]): void {
    this.closeFlow(`Installing into: ${titlesOf(want)}`);
  }

  fetching(): void {
    log.step('[Fetch]');
  }

  sourceReady(): void {
    log.ok('Plugin source ready');
  }

  beginHarness(title: string): void {
    log.step(`[${title}]`);
  }

  /** A harness that needs the files when none were fetched. */
  noSource(title: string): void {
    log.warn(`${title} not detected - skipping.`);
  }

  summary(installed: readonly HarnessName[], untouched: readonly HarnessName[]): void {
    log.plain('');
    log.rule();
    if (!installed.length) log.warn(nothingChanged());
    else log.ok(`Installed into: ${titlesOf(installed)}`);
    if (untouched.length) log.info(`Already installed: ${titlesOf(untouched)}`);
    log.plain('');
  }

  /**
   * Why there was no editor to install into, which differs by whether the user
   * named one: a typo in `--targets` deserves the name back, and a machine with
   * no editor at all deserves the list.
   */
  static noEditor(
    explicit: boolean,
    missing: readonly HarnessName[],
  ): { message: string; hint: string } {
    const names = missing.map((n) => TITLES[n]);
    return explicit
      ? {
          message: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} not installed on this machine.`,
          hint: `Install it first, or choose another with --targets ${NAMES.join(',')}.`,
        }
      : {
          message: 'No supported editor found on this machine.',
          hint: `Install ${everyEditor('or')}, then run this again.`,
        };
  }
}
