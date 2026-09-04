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
