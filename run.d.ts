import type { Profile } from './lib/types.js';

/** Runs the CLI with a preset profile; flags and CP_* env still take precedence. */
declare function runWithProfile(profile?: Profile, argv?: string[]): Promise<number>;

export = runWithProfile;
