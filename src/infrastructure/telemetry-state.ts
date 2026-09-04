import * as fs from 'node:fs';

import { Failure } from '../types/failure.js';
import type { FilePath } from '../types/file/paths.js';
import { err, ok, type Result } from '../types/result.js';
import { errorCode, errorMessage, isPlainObject, nonEmptyString, stripBom } from '../util.js';
import { ensureDir } from './file-system.js';

export interface TelemetryState {
  id: string | null;
  enabled?: boolean;
  noticeShown?: boolean;
}

/** `null` is a missing file; `unreadable` is a file that exists but cannot be trusted. */
export type StateRead = TelemetryState | null | 'unreadable';

// A missing file is the fresh-machine case. Anything else that cannot be read is
// not "absent": treating it so would drop a saved opt-out, so it fails closed.
export function readState(file: FilePath): StateRead {
  let text: string;
  try {
    text = fs.readFileSync(file.toString(), 'utf8');
  } catch (e) {
    const code = errorCode(e);
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'unreadable';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return 'unreadable';
  }
  if (!isPlainObject(parsed)) return 'unreadable';
  const state: TelemetryState = { id: nonEmptyString(parsed.id) ? parsed.id : null };
  if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled;
  if (typeof parsed.noticeShown === 'boolean') state.noticeShown = parsed.noticeShown;
  return state;
}

/**
 * Written whole through a rename, so a crash mid-write cannot leave the half
 * file that would read as unreadable above. A failure comes back as a Failure
 * rather than a log line: whether anyone hears about it is the caller's call.
 */
export function writeState(file: FilePath, state: TelemetryState): Result<void, Failure> {
  const tmp = file.withSuffix(`.${process.pid}.tmp`);
  try {
    ensureDir(file.parent());
    fs.writeFileSync(tmp.toString(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp.toString(), file.toString());
    return ok(undefined);
  } catch (e) {
    fs.rmSync(tmp.toString(), { force: true });
    return err(new Failure(`telemetry: could not write ${file}: ${errorMessage(e)}`));
  }
}

export const withId = (state: TelemetryState | null, newId: () => string): TelemetryState =>
  state?.id ? state : { ...state, id: newId() };
