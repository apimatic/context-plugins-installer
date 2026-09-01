import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ghHeaders } from './catalog.js';
import { log } from './log.js';
import type { Deps, FetchLike, MaterializedSource, RepoHandle, RunResult } from './types.js';
import {
  UserError,
  ensureDir,
  rmrf,
  isDirNonEmpty,
  which,
  run,
  pool,
  isSha,
  countFiles,
  isPlainObject,
  errorMessage,
} from './util.js';

export const DOWNLOAD_CONCURRENCY = 8;

/** A throwaway working directory, and a cleanup that never throws. */
function tempWorkspace(): { work: string; cleanup: () => void } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'context-plugins-'));
  const cleanup = () => {
    try {
      rmrf(work);
    } catch {
      /* a locked temp dir is not worth failing the install over */
    }
  };
  return { work, cleanup };
}

export interface SourceRequest {
  repo: string;
  ref: string;
  sourcePath: string;
  deps?: Deps;
}

/**
 * Materialize `sourcePath` from `repo@ref` into a temp directory.
 * Returns { dir, cleanup, via }. Callers must call cleanup() in a finally block.
 */
export async function materialize({
  repo,
  ref,
  sourcePath,
  deps = {},
}: SourceRequest): Promise<MaterializedSource> {
  const { work, cleanup } = tempWorkspace();

  try {
    // deps.env, like openRepo below - so an injected PATH can force the API
    // route here too, instead of only on the session path.
    const git = which('git', deps.env || process.env);
    if (git) {
      const dir = await viaGit({ git, repo, ref, sourcePath, work });
      return { dir, cleanup, via: 'git' };
    }
    log.warn('git not found - falling back to the GitHub API (60 requests/hour unauthenticated).');
    const dir = await viaApi({ repo, ref, sourcePath, work, deps });
    return { dir, cleanup, via: 'api' };
  } catch (err) {
    cleanup();
    throw err;
  }
}

interface CloneRequest {
  git: string;
  repo: string;
  ref: string;
  work: string;
}

/** Clone the repository itself, with no plugin folder checked out yet. */
export async function cloneRepo({ git, repo, ref, work }: CloneRequest): Promise<string> {
  const clone = path.join(work, 'repo');
  const url = `https://github.com/${repo}.git`;
  log.info('Fetching marketplace via git ...');
  log.debug(`${url} (${ref})`);

  const base = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse'];

  if (isSha(ref)) {
    // --branch does not accept a commit sha, so clone the default branch and
    // fetch the exact commit.
    await expect(run(git, [...base, url, clone]), `git clone ${url}`);
    await expect(
      run(git, ['-C', clone, 'fetch', '--depth', '1', 'origin', ref]),
      `git fetch ${ref}`,
    );
    await expect(
      run(git, ['-C', clone, 'checkout', '--quiet', 'FETCH_HEAD']),
      `git checkout ${ref}`,
    );
  } else {
    await expect(
      run(git, [...base, '--branch', ref, url, clone]),
      `git clone ${url} (branch ${ref})`,
    );
  }
  return clone;
}

interface SparseRequest {
  git: string;
  clone: string;
  repo: string;
  ref: string;
  sourcePath: string;
}

/**
 * Add one plugin folder to an existing clone's sparse checkout.
 *
 * `add` rather than `set`: a --sparse clone starts with only the root files, so
 * for the first path the two are equivalent, and `add` lets later plugins join
 * the same working tree instead of replacing what is already there.
 */
export async function addSparsePath({
  git,
  clone,
  repo,
  ref,
  sourcePath,
}: SparseRequest): Promise<string> {
  await expect(
    run(git, ['-C', clone, 'sparse-checkout', 'add', sourcePath]),
    `git sparse-checkout add ${sourcePath}`,
  );

  const dir = path.join(clone, ...sourcePath.split('/'));
  if (!isDirNonEmpty(dir)) {
    throw new UserError(`Plugin folder '${sourcePath}' is empty or missing in ${repo}@${ref}.`);
  }
  log.debug(`${countFiles(dir)} files checked out`);
  return dir;
}

export async function viaGit({
  git,
  repo,
  ref,
  sourcePath,
  work,
}: CloneRequest & { sourcePath: string }): Promise<string> {
  const clone = await cloneRepo({ git, repo, ref, work });
  return addSparsePath({ git, clone, repo, ref, sourcePath });
}

async function expect(promise: Promise<RunResult>, what: string): Promise<RunResult> {
  const result = await promise;
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new UserError(`${what} failed (exit ${result.code}). ${detail}`.trim());
  }
  return result;
}

interface TreeNode {
  type: string;
  path: string;
}

/** The parts of GitHub's git/trees response the download path relies on. */
export interface GitTree {
  truncated: boolean;
  tree: TreeNode[];
}

/** The API's answer is a JSON boundary: keep the nodes that have the two fields used. */
function asTree(data: unknown): GitTree {
  if (!isPlainObject(data)) {
    throw new UserError('GitHub tree response was not a JSON object.', {
      hint: 'Install git and re-run for a reliable fetch.',
    });
  }
  const nodes: unknown[] = Array.isArray(data.tree) ? data.tree : [];
  return {
    truncated: data.truncated === true,
    tree: nodes.filter(
      (n): n is TreeNode =>
        isPlainObject(n) && typeof n.type === 'string' && typeof n.path === 'string',
    ),
  };
}

/** The repository's file tree. One request, reusable for every plugin in it. */
export async function fetchTree({
  repo,
  ref,
  deps = {},
}: {
  repo: string;
  ref: string;
  deps?: Deps;
}): Promise<GitTree> {
  const fetchImpl: FetchLike = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  let body: unknown;
  try {
    const res = await fetchImpl(treeUrl, { headers: ghHeaders(env) });
    if (!res.ok) {
      throw new UserError(
        `GitHub API request failed (${res.status} ${res.statusText || ''}).`.trim(),
        { hint: 'Install git and re-run for a reliable fetch, or set GITHUB_TOKEN.' },
      );
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`GitHub API request failed: ${treeUrl}`, { hint: errorMessage(err) });
  }

  const tree = asTree(body);
  if (tree.truncated) {
    log.warn('GitHub tree response was truncated; some files may be missing. Prefer git.');
  }
  return tree;
}

interface DownloadRequest extends SourceRequest {
  tree: GitTree;
  work: string;
}

/** Download one plugin folder out of an already-fetched tree. */
export async function downloadPath({
  tree,
  repo,
  ref,
  sourcePath,
  work,
  deps = {},
}: DownloadRequest): Promise<string> {
  const fetchImpl: FetchLike = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  // Mirror the repository layout so two plugins never share a destination.
  const dest = ensureDir(path.join(work, 'files', ...sourcePath.split('/')));

  const prefix = `${sourcePath}/`;
  const blobs = tree.tree.filter((n) => n.type === 'blob' && n.path.startsWith(prefix));
  if (!blobs.length) {
    throw new UserError(`Plugin folder '${sourcePath}' has no files in ${repo}@${ref}.`);
  }

  await pool(blobs, DOWNLOAD_CONCURRENCY, async (blob) => {
    const rel = blob.path.slice(prefix.length);
    const target = path.join(dest, ...rel.split('/'));
    ensureDir(path.dirname(target));
    const raw = `https://raw.githubusercontent.com/${repo}/${ref}/${blob.path}`;
    const res = await fetchImpl(raw, { headers: ghHeaders(env) });
    if (!res.ok) throw new UserError(`Download failed (${res.status}): ${blob.path}`);
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  });

  log.info(`Downloaded ${blobs.length} files via the GitHub API.`);
  return dest;
}

export async function viaApi({
  repo,
  ref,
  sourcePath,
  work,
  deps = {},
}: SourceRequest & { work: string }): Promise<string> {
  const tree = await fetchTree({ repo, ref, deps });
  return downloadPath({ tree, repo, ref, sourcePath, work, deps });
}

/**
 * Open `repo@ref` once and check plugin folders out of it on demand.
 *
 * `update` re-installs every recorded plugin, and materializing each one
 * separately meant cloning the whole marketplace once per plugin - work that
 * grows with the marketplace, not with what you asked for. One handle clones (or
 * fetches the API tree) once and every checkout after that is local.
 *
 * Callers must call cleanup() when the run is done.
 */
export async function openRepo({
  repo,
  ref,
  deps = {},
}: {
  repo: string;
  ref: string;
  deps?: Deps;
}): Promise<RepoHandle> {
  const { work, cleanup } = tempWorkspace();

  const done = new Map<string, string>();
  const git = which('git', deps.env || process.env);

  if (git) {
    let cloning: Promise<string> | null = null;
    return {
      via: 'git',
      cleanup,
      async checkout(sourcePath) {
        const cached = done.get(sourcePath);
        if (cached) return cached;
        // Store the promise, not the result, so concurrent callers share one clone.
        cloning ??= cloneRepo({ git, repo, ref, work });
        const clone = await cloning;
        const dir = await addSparsePath({ git, clone, repo, ref, sourcePath });
        done.set(sourcePath, dir);
        return dir;
      },
    };
  }

  log.warn('git not found - falling back to the GitHub API (60 requests/hour unauthenticated).');
  let fetching: Promise<GitTree> | null = null;
  return {
    via: 'api',
    cleanup,
    async checkout(sourcePath) {
      const cached = done.get(sourcePath);
      if (cached) return cached;
      fetching ??= fetchTree({ repo, ref, deps });
      const tree = await fetching;
      const dir = await downloadPath({ tree, repo, ref, sourcePath, work, deps });
      done.set(sourcePath, dir);
      return dir;
    },
  };
}
