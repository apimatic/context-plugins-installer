// The command line after parsing. Every flag is optional here because absence
// is meaningful: it is what lets env and rc values take over.

export interface Flags {
  repo?: string;
  ref?: string;
  marketplace?: string;
  targets?: string;
  force?: boolean;
  yes?: boolean;
  long?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface ParsedArgs {
  command: string | null;
  args: string[];
  flags: Flags;
}
