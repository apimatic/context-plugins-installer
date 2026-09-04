import * as fs from 'node:fs';
import * as path from 'node:path';

import { pathString, type PathArg } from '../types/file/paths.js';

// Every one of these walks the filesystem of the machine it runs on, so it joins
// with the host's rules: a path's own rules describe where it points, not where
// the bytes are. They are the boundary at which a path becomes a string.

export function ensureDir(dir: PathArg): string {
  const target = pathString(dir);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Creates the directory that will hold `file`, by the *host's* rules. A path's
 * own rules say where it points; the bytes land on this machine either way, so
 * the host's are the ones that matter at an fs boundary. Deriving the parent
 * from a path's own rules made a foreign-platform path resolve to `.`, which
 * created nothing and left the write to fail naming the file, not the folder.
 */
export function ensureDirFor(file: PathArg): string {
  return ensureDir(path.dirname(pathString(file)));
}

/**
 * Written whole through a rename, so a crash, a full disk or a kill mid-write
 * leaves the previous file rather than a truncated one. Both state files this
 * program keeps are read back with a catch that treats a parse failure as
 * empty, which is exactly how a half-written file loses every row it held.
 */
export function writeFileAtomic(file: PathArg, contents: string): void {
  const target = pathString(file);
  const tmp = `${target}.${process.pid}.tmp`;
  ensureDirFor(target);
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    // `force: true` only swallows ENOENT, so this can throw in its own right -
    // and must not replace the reason we are here.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* a temp file outliving the failure is the lesser problem */
    }
    throw e;
  }
}

export function rmrf(target: PathArg): void {
  fs.rmSync(pathString(target), { recursive: true, force: true });
}

export function exists(target: PathArg): boolean {
  try {
    fs.statSync(pathString(target));
    return true;
  } catch {
    return false;
  }
}

export function isDirNonEmpty(dir: PathArg): boolean {
  const target = pathString(dir);
  try {
    return fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0;
  } catch {
    return false;
  }
}

// Hand-written so it never emits fs.cp's experimental warning.
export function copyDir(src: PathArg, dest: PathArg): void {
  const target = ensureDir(dest);
  const source = pathString(src);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isSymbolicLink()) {
      // Symlinks need elevation on Windows; degrade to a plain copy.
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch {
        try {
          fs.copyFileSync(from, to);
        } catch {
          /* unresolvable link */
        }
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Wholesale replace, so a shrinking plugin leaves no orphan files behind. */
export function replaceDir(src: PathArg, dest: PathArg): string {
  rmrf(dest);
  copyDir(src, dest);
  return pathString(dest);
}

export function countFiles(dir: PathArg): number {
  const target = pathString(dir);
  let n = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(target, entry.name)) : 1;
  }
  return n;
}
