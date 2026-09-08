import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Failure } from '../types/failure.js';
import { DirectoryPath } from '../types/file/paths.js';
import { GitRef } from '../types/ids/git-ref.js';
import { RepoSlug } from '../types/ids/repo-slug.js';
import type {
  HttpPorts,
  MaterializedSource,
  ProcessRunner,
  RunResult,
  SourcePorts,
} from '../types/ports.js';
import { ok, err, type Result } from '../types/result.js';
import type { MarketplaceListener, RepoHandle } from '../types/session.js';
import { isPlainObject, errorMessage } from '../types/util.js';
import { countFiles, ensureDir, isDirNonEmpty, rmrf } from './file-system.js';
import { ghHeaders } from './github-registry-client.js';

export const DOWNLOAD_CONCURRENCY = 8;

/** Bounded-concurrency map, in input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

// Nothing here prints. What the old code said out loud - that git is missing,
// that a clone has started, how many files arrived - is emitted as an event the
// moment it happens, so a caller renders it in the same order a `log` call did.
const nothing: MarketplaceListener = () => {};

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
  notify?: MarketplaceListener;
}

/** Callers must call cleanup() when done, on the failure arm too. */
export async function materialize(
  { repo, ref, sourcePath, notify = nothing }: SourceRequest,
  ports: SourcePorts,
): Promise<Result<MaterializedSource, Failure>> {
  const { work, cleanup } = tempWorkspace();

  // A Failure is not the only way out: a spawn that never starts, a full disk, a
  // response body that dies mid-read all throw, and the workspace has to go
  // either way. Only the success arm hands `cleanup` to the caller.
  try {
    const git = ports.runner.which('git');
    // The API route is what happens when git is absent, and saying so before the
    // work starts is the point of the line.
    if (!git) notify({ kind: 'no-git' });
    const dir = git
      ? await viaGit({ git, repo, ref, sourcePath, work, notify }, ports.runner)
      : await viaApi({ repo, ref, sourcePath, work, notify }, ports);
    if (!dir.ok) {
      cleanup();
      return err(dir.error);
    }
    return ok({ dir: new DirectoryPath(dir.value), cleanup, via: git ? 'git' : 'api' });
  } catch (e) {
    cleanup();
    throw e;
  }
}

interface CloneRequest {
  git: string;
  repo: string;
  ref: string;
  work: string;
  notify?: MarketplaceListener;
}

export async function cloneRepo(
  { git, repo, ref, work, notify = nothing }: CloneRequest,
  { run }: ProcessRunner,
): Promise<Result<string, Failure>> {
  const clone = path.join(work, 'repo');
  const url = new RepoSlug(repo).cloneUrl();
  notify({ kind: 'cloning', url, ref });

  const base = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse'];

  if (new GitRef(ref).isSha()) {
    // --branch does not accept a commit sha.
    const cloned = await expect(run(git, [...base, url, clone]), `git clone ${url}`);
    if (!cloned.ok) return err(cloned.error);
    const fetched = await expect(
      run(git, ['-C', clone, 'fetch', '--depth', '1', 'origin', ref]),
      `git fetch ${ref}`,
    );
    if (!fetched.ok) return err(fetched.error);
    const checked = await expect(
      run(git, ['-C', clone, 'checkout', '--quiet', 'FETCH_HEAD']),
      `git checkout ${ref}`,
    );
    if (!checked.ok) return err(checked.error);
  } else {
    const cloned = await expect(
      run(git, [...base, '--branch', ref, url, clone]),
      `git clone ${url} (branch ${ref})`,
    );
    if (!cloned.ok) return err(cloned.error);
  }
  return ok(clone);
}

interface SparseRequest {
  git: string;
  clone: string;
  repo: string;
  ref: string;
  sourcePath: string;
  notify?: MarketplaceListener;
}

// `add` rather than `set`, so later plugins join the same working tree
// instead of replacing what is already checked out.
export async function addSparsePath(
  { git, clone, repo, ref, sourcePath, notify = nothing }: SparseRequest,
  { run }: ProcessRunner,
): Promise<Result<string, Failure>> {
  const added = await expect(
    run(git, ['-C', clone, 'sparse-checkout', 'add', sourcePath]),
    `git sparse-checkout add ${sourcePath}`,
  );
  if (!added.ok) return err(added.error);

  const dir = path.join(clone, ...sourcePath.split('/'));
  if (!isDirNonEmpty(dir)) {
    return err(new Failure(`Plugin folder '${sourcePath}' is empty or missing in ${repo}@${ref}.`));
  }
  notify({ kind: 'checked-out', files: countFiles(dir) });
  return ok(dir);
}

export async function viaGit(
  { git, repo, ref, sourcePath, work, notify }: CloneRequest & { sourcePath: string },
  runner: ProcessRunner,
): Promise<Result<string, Failure>> {
  const clone = await cloneRepo({ git, repo, ref, work, notify }, runner);
  if (!clone.ok) return err(clone.error);
  return addSparsePath({ git, clone: clone.value, repo, ref, sourcePath, notify }, runner);
}

async function expect(
  promise: Promise<RunResult>,
  what: string,
): Promise<Result<RunResult, Failure>> {
  const result = await promise;
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    return err(new Failure(`${what} failed (exit ${result.code}). ${detail}`.trim()));
  }
  return ok(result);
}

interface TreeNode {
  type: string;
  path: string;
}

export interface GitTree {
  truncated: boolean;
  tree: TreeNode[];
}

function asTree(data: unknown): Result<GitTree, Failure> {
  if (!isPlainObject(data)) {
    return err(
      new Failure(
        'GitHub tree response was not a JSON object.',
        'Install git and re-run for a reliable fetch.',
      ),
    );
  }
  const nodes: unknown[] = Array.isArray(data.tree) ? data.tree : [];
  return ok({
    truncated: data.truncated === true,
    tree: nodes.filter(
      (n): n is TreeNode =>
        isPlainObject(n) && typeof n.type === 'string' && typeof n.path === 'string',
    ),
  });
}

export async function fetchTree(
  { repo, ref, notify = nothing }: { repo: string; ref: string; notify?: MarketplaceListener },
  { fetch: fetchImpl, env }: HttpPorts,
): Promise<Result<GitTree, Failure>> {
  const treeUrl = new RepoSlug(repo).treeUrl(ref);
  let body: unknown;
  try {
    const res = await fetchImpl(treeUrl, { headers: ghHeaders(env) });
    if (!res.ok) {
      return err(
        new Failure(
          `GitHub API request failed (${res.status} ${res.statusText || ''}).`.trim(),
          'Install git and re-run for a reliable fetch, or set GITHUB_TOKEN.',
        ),
      );
    }
    body = await res.json();
  } catch (e) {
    return err(new Failure(`GitHub API request failed: ${treeUrl}`, errorMessage(e)));
  }

  const tree = asTree(body);
  if (tree.ok && tree.value.truncated) notify({ kind: 'tree-truncated' });
  return tree;
}

interface DownloadRequest extends SourceRequest {
  tree: GitTree;
  work: string;
}

export async function downloadPath(
  { tree, repo, ref, sourcePath, work, notify = nothing }: DownloadRequest,
  { fetch: fetchImpl, env }: HttpPorts,
): Promise<Result<string, Failure>> {
  // Mirrors the repository layout so two plugins never share a destination.
  const dest = new DirectoryPath(ensureDir(path.join(work, 'files', ...sourcePath.split('/'))));

  const prefix = `${sourcePath}/`;
  const blobs = tree.tree.filter((n) => n.type === 'blob' && n.path.startsWith(prefix));
  if (!blobs.length) {
    return err(new Failure(`Plugin folder '${sourcePath}' has no files in ${repo}@${ref}.`));
  }

  // One mkdir per directory rather than one per file: a plugin is mostly flat,
  // so this was the same syscall repeated for every blob in the folder.
  const made = new Set<string>();
  const slug = new RepoSlug(repo);
  const failures: Failure[] = [];
  await pool(blobs, DOWNLOAD_CONCURRENCY, async (blob) => {
    if (failures.length) return;
    const rel = blob.path.slice(prefix.length);
    const target = dest.file(...rel.split('/'));
    // A tree entry is remote input, so it does not get to name where we write.
    if (!dest.contains(target)) {
      failures.push(new Failure(`Refusing to write outside the checkout: ${blob.path}`));
      return;
    }
    const parent = target.parent().toString();
    if (!made.has(parent)) {
      ensureDir(parent);
      made.add(parent);
    }
    const raw = slug.rawUrl(ref, blob.path);
    const res = await fetchImpl(raw, { headers: ghHeaders(env) });
    if (!res.ok) {
      failures.push(new Failure(`Download failed (${res.status}): ${blob.path}`));
      return;
    }
    fs.writeFileSync(target.toString(), Buffer.from(await res.arrayBuffer()));
  });
  const first = failures[0];
  if (first) return err(first);

  notify({ kind: 'downloaded', files: blobs.length });
  return ok(dest.toString());
}

export async function viaApi(
  { repo, ref, sourcePath, work, notify = nothing }: SourceRequest & { work: string },
  ports: HttpPorts,
): Promise<Result<string, Failure>> {
  const tree = await fetchTree({ repo, ref, notify }, ports);
  if (!tree.ok) return err(tree.error);
  return downloadPath({ tree: tree.value, repo, ref, sourcePath, work, notify }, ports);
}

/** One clone (or API tree) per repo@ref; every checkout after the first is local. Callers must call cleanup(). */
export async function openRepo(
  { repo, ref, notify = nothing }: { repo: string; ref: string; notify?: MarketplaceListener },
  ports: SourcePorts,
): Promise<RepoHandle> {
  const { work, cleanup } = tempWorkspace();

  const done = new Map<string, DirectoryPath>();
  const git = ports.runner.which('git');

  if (git) {
    let cloning: Promise<Result<string, Failure>> | null = null;
    return {
      via: 'git',
      cleanup,
      async checkout(sourcePath) {
        const cached = done.get(sourcePath);
        if (cached) return ok(cached);
        // The promise is cached, not the result, so concurrent callers share one clone.
        cloning ??= cloneRepo({ git, repo, ref, work, notify }, ports.runner);
        const clone = await cloning;
        if (!clone.ok) return err(clone.error);
        const dir = await addSparsePath(
          { git, clone: clone.value, repo, ref, sourcePath, notify },
          ports.runner,
        );
        if (!dir.ok) return err(dir.error);
        const at = new DirectoryPath(dir.value);
        done.set(sourcePath, at);
        return ok(at);
      },
    };
  }

  notify({ kind: 'no-git' });
  let fetching: Promise<Result<GitTree, Failure>> | null = null;
  return {
    via: 'api',
    cleanup,
    async checkout(sourcePath) {
      const cached = done.get(sourcePath);
      if (cached) return ok(cached);
      fetching ??= fetchTree({ repo, ref, notify }, ports);
      const tree = await fetching;
      if (!tree.ok) return err(tree.error);
      const dir = await downloadPath(
        { tree: tree.value, repo, ref, sourcePath, work, notify },
        ports,
      );
      if (!dir.ok) return err(dir.error);
      const at = new DirectoryPath(dir.value);
      done.set(sourcePath, at);
      return ok(at);
    },
  };
}

/**
 * The fetcher the composition root builds. One method, because one is all
 * anything above infrastructure needs: `openRepo` decides between a clone and
 * the API from the git it can find, and hands back a handle that checks out
 * each plugin folder once.
 */
export interface SourceFetcher {
  openRepo(args: { repo: string; ref: string; notify?: MarketplaceListener }): Promise<RepoHandle>;
}

export const sourceFetcher = (ports: SourcePorts): SourceFetcher => ({
  openRepo: (args) => openRepo(args, ports),
});
