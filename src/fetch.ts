import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ghHeaders } from './catalog.js';
import { log } from './log.js';
import { DirectoryPath } from './types/file/paths.js';
import { GitRef } from './types/ids/git-ref.js';
import { RepoSlug } from './types/ids/repo-slug.js';
import type { Deps, FetchLike, MaterializedSource, RunResult } from './types/ports.js';
import type { RepoHandle } from './types/session.js';
import { UserError, pool, isPlainObject, errorMessage } from './util.js';
import { countFiles, ensureDir, isDirNonEmpty, rmrf } from './infrastructure/file-system.js';
import { run, which } from './infrastructure/process-runner.js';

export const DOWNLOAD_CONCURRENCY = 8;

function tempWorkspace(): { work: string; cleanup: () => void } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'context-plugins-'));
  const cleanup = () => {
    try {
      rmrf(work);
    } catch {
      /* a locked temp dir is not worth failing over */
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

/** Callers must call cleanup() when done. */
export async function materialize({
  repo,
  ref,
  sourcePath,
  deps = {},
}: SourceRequest): Promise<MaterializedSource> {
  const { work, cleanup } = tempWorkspace();

  try {
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

export async function cloneRepo({ git, repo, ref, work }: CloneRequest): Promise<string> {
  const clone = path.join(work, 'repo');
  const url = new RepoSlug(repo).cloneUrl();
  log.info('Fetching marketplace via git ...');
  log.debug(`${url} (${ref})`);

  const base = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse'];

  if (new GitRef(ref).isSha()) {
    // --branch does not accept a commit sha.
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

// `add` rather than `set`, so later plugins join the same working tree
// instead of replacing what is already checked out.
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

export interface GitTree {
  truncated: boolean;
  tree: TreeNode[];
}

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
  const treeUrl = new RepoSlug(repo).treeUrl(ref);
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
  // Mirrors the repository layout so two plugins never share a destination.
  const dest = new DirectoryPath(ensureDir(path.join(work, 'files', ...sourcePath.split('/'))));

  const prefix = `${sourcePath}/`;
  const blobs = tree.tree.filter((n) => n.type === 'blob' && n.path.startsWith(prefix));
  if (!blobs.length) {
    throw new UserError(`Plugin folder '${sourcePath}' has no files in ${repo}@${ref}.`);
  }

  const slug = new RepoSlug(repo);
  await pool(blobs, DOWNLOAD_CONCURRENCY, async (blob) => {
    const rel = blob.path.slice(prefix.length);
    const target = dest.file(...rel.split('/'));
    // A tree entry is remote input, so it does not get to name where we write.
    if (!dest.contains(target)) {
      throw new UserError(`Refusing to write outside the checkout: ${blob.path}`);
    }
    ensureDir(target.parent());
    const raw = slug.rawUrl(ref, blob.path);
    const res = await fetchImpl(raw, { headers: ghHeaders(env) });
    if (!res.ok) throw new UserError(`Download failed (${res.status}): ${blob.path}`);
    fs.writeFileSync(target.toString(), Buffer.from(await res.arrayBuffer()));
  });

  log.info(`Downloaded ${blobs.length} files via the GitHub API.`);
  return dest.toString();
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

/** One clone (or API tree) per repo@ref; every checkout after the first is local. Callers must call cleanup(). */
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
        // The promise is cached, not the result, so concurrent callers share one clone.
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
