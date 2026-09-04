// The outcome of splicing a plugin folder into VS Code's settings.json. The file
// is JSONC the user also edits by hand, so an edit is a targeted string splice
// and these say exactly which one happened.

/** `failed` means the file was left untouched: no object could be spliced into. */
export type AddLocationAction =
  | 'created'
  | 'reset'
  | 'already'
  | 'inserted-empty'
  | 'inserted-existing'
  | 'inserted-key'
  /** The path is already a key, but not the `"<key>": true` this tool writes. */
  | 'conflict'
  | 'failed';

/**
 * `absent` is a positive answer - the file does not name this path at all.
 * `unremovable` is not: the path IS named, in a form the splice does not
 * recognise, so VS Code may still be loading it. Callers must not read the two
 * as the same thing.
 */
export type RemoveLocationAction = 'missing' | 'absent' | 'unremovable' | 'removed';

export interface AddLocationResult {
  action: AddLocationAction;
  backup: string | null;
}

export interface RemoveLocationResult {
  action: RemoveLocationAction;
  backup: string | null;
}
