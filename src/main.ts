import { run as route } from './commands/router.js';
import { services } from './composition.js';

/**
 * The process entry point, and the only thing `bin/cli.js` requires. It is its
 * own file so that building what a run needs happens above every command and
 * below the shell: the router is handed its services rather than reaching for
 * them, which is what lets `src/commands` be barred from `src/infrastructure`
 * altogether.
 */
export const run = (argv: readonly string[] = process.argv.slice(2)): Promise<number> =>
  route(argv, services());
