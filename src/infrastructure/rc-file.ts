import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RcFile } from '../types/brand.js';
import { Failure } from '../types/failure.js';
import { err, ok, type Result } from '../types/result.js';
import { errorCode, errorMessage, isPlainObject, stripBom } from '../util.js';

export const RC_NAME = '.contextpluginsrc';

type RcStringField = Exclude<keyof RcFile, 'telemetry'>;

// Unknown rc keys are ignored, so a newer version's file does not break an older CLI.
const RC_STRING_FIELDS: readonly RcStringField[] = [
  'repo',
  'ref',
  'marketplace',
  'displayName',
  'marketplaceLabel',
];

/**
 * `ok(null)` is absence, which is the ordinary case. Anything the user wrote and
 * got wrong is a Failure naming the file, because this is configuration rather
 * than shared state: falling back to the defaults silently would install from
 * the wrong marketplace.
 */
export function readRc(dir: string | undefined): Result<RcFile | null, Failure> {
  if (!dir) return ok(null);
  const file = path.join(dir, RC_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    // ENOTDIR means a component of the path is a file, so no rc file can exist
    // there - the same proof of absence ENOENT gives. Both are "carry on".
    if (errorCode(e) === 'ENOENT' || errorCode(e) === 'ENOTDIR') return ok(null);
    if (e instanceof SyntaxError) {
      return err(new Failure(`${file} is not valid JSON: ${e.message}`));
    }
    // A file that may well be there and cannot be read - a directory, a
    // permission wall - must not read as absence.
    return err(new Failure(`Could not read ${file}: ${errorMessage(e)}`));
  }
  if (!isPlainObject(parsed)) {
    return err(new Failure(`${file} must be a JSON object.`));
  }
  const rc: RcFile = {};
  for (const field of RC_STRING_FIELDS) {
    const value = parsed[field];
    // null means unset, as the resolution chain treats it.
    if (value != null && typeof value !== 'string') {
      return err(new Failure(`${file}: '${field}' must be a string.`));
    }
    if (typeof value === 'string') rc[field] = value;
  }
  if (parsed.telemetry != null) {
    if (typeof parsed.telemetry !== 'boolean') {
      return err(new Failure(`${file}: 'telemetry' must be true or false.`));
    }
    rc.telemetry = parsed.telemetry;
  }
  return ok(rc);
}
