import type { ActionResult } from '../actions/action-result.js';
import { RouterPrompts } from '../prompts/router.js';
import { BIN } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import type { Services } from '../types/services.js';
import { errorMessage } from '../types/util.js';
import { TARGET_AWARE, parseArgs, parseTargets } from './args.js';
import { DoctorCommand } from './doctor.js';
import { helpText } from './help.js';
import { InstallCommand } from './install.js';
import { InstalledCommand } from './installed.js';
import { ListCommand } from './list.js';
import { TelemetryCommand } from './telemetry.js';
import { UninstallCommand } from './uninstall.js';
import { UpdateCommand } from './update.js';

// The one place a command line becomes a run: parse, configure the terminal,
// resolve the brand, dispatch, flush what was reported, answer with an exit
// code. Nothing here decides anything about a plugin; every case is three
// lines because each command owns its own flow.
//
// Exit codes: 2 is "this command line is wrong" - a bad flag, or an rc file
// that cannot be read, which is the command line broadly read. 1 is "the run
// did not work". 0 is nothing to report. A missing plugin id exits 1 rather
// than 2 because the command was understood; it just had nothing to work on.

/** Returns the process exit code. */
export async function run(argv: readonly string[], services: Services): Promise<number> {
  const prompts = new RouterPrompts();

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    prompts.failure(parsed.error);
    return 2;
  }
  const { command, args, flags } = parsed.value;
  prompts.configure(flags);

  // Before the brand resolves, so a broken rc file cannot hide the version.
  if (flags.version) {
    prompts.version(services.version());
    return 0;
  }

  const resolved = services.brand(flags);
  if (!resolved.ok) {
    prompts.failure(resolved.error);
    return 2;
  }
  const brand = resolved.value;

  if (flags.help || !command || command === 'help') {
    prompts.help(helpText(BIN, brand));
    return command || flags.help ? 0 : 2;
  }

  const targets = parseTargets(flags.targets);
  const plugin = args[0] || process.env.CP_PLUGIN || null;
  if (targets?.length && !TARGET_AWARE.has(command)) prompts.targetsIgnored(command);

  /** What the run said, and what the shell should make of it. */
  const answer = (result: ActionResult<unknown>): number => {
    if (result.failure) prompts.failure(result.failure);
    return result.exitCode();
  };
  const noPlugin = (usage: string): number => {
    prompts.failure(new Failure('No plugin specified.', usage));
    return 1;
  };

  // One instance per run: install and uninstall report into it, and whatever
  // they reported leaves in a single request once the command is done. `remove`
  // is the same operation as `uninstall`, so it reports as one.
  const telemetry = services.telemetry(brand, command === 'remove' ? 'uninstall' : command);
  const sink = services.sink(telemetry, (message) => prompts.debug(message));

  try {
    switch (command) {
      case 'install': {
        if (!plugin) return noPlugin(`Usage: ${BIN} install <plugin>   (or set CP_PLUGIN)`);
        const session = services.session(prompts.marketplaceListener);
        try {
          return answer(
            await new InstallCommand(sink).run(
              {
                brand,
                plugin,
                ref: flags.ref,
                targets,
                force: flags.force,
                assumeYes: flags.yes,
              },
              session,
            ),
          );
        } finally {
          await session.cleanup();
        }
      }
      case 'uninstall':
      case 'remove': {
        if (!plugin) return noPlugin(`Usage: ${BIN} uninstall <plugin>`);
        return answer(
          await new UninstallCommand(sink).run({ brand, plugin, targets, force: flags.force }),
        );
      }
      case 'update':
        return answer(await new UpdateCommand(sink).run({ brand }));
      case 'list':
        return answer(await new ListCommand().run({ brand, json: flags.json, long: flags.long }));
      case 'doctor':
        return answer(await new DoctorCommand().run({ brand, json: flags.json }));
      case 'installed':
        return answer(
          new InstalledCommand().run({ targets, json: flags.json }, services.manifest()),
        );
      case 'telemetry':
        return answer(
          new TelemetryCommand().run({ action: args[0] }, services.telemetrySettings(brand)),
        );
      default:
        prompts.failure(
          new Failure(`Unknown command: ${command}`, `Run \`${BIN} --help\` for usage.`),
        );
        return 1;
    }
  } catch (err) {
    // Nothing below here throws on purpose, so this is a bug: say what it was
    // and keep the stack for --verbose.
    prompts.crash(errorMessage(err), err instanceof Error ? err.stack : undefined);
    return 1;
  } finally {
    // The sender never prints. It hands back what it would have said, in order,
    // and one renderer puts it on the terminal.
    prompts.flushed(await telemetry.flush());
  }
}
