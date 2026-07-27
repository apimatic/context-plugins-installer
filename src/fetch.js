'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./log');
const { ghHeaders } = require('./catalog');
const {
  UserError,
  ensureDir,
  rmrf,
  isDirNonEmpty,
  which,
  run,
  pool,
  isSha,
  countFiles,
} = require('./util');

const DOWNLOAD_CONCURRENCY = 8;

/**
 * Materialize `sourcePath` from `repo@ref` into a temp directory.
 * Returns { dir, cleanup, via }. Callers must call cleanup() in a finally block.
 */
async function materialize({ repo, ref, sourcePath, deps = {} }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'context-plugins-'));
  const cleanup = () => {
    try {
      rmrf(work);
    } catch {
      /* a locked temp dir is not worth failing the install over */
    }
  };

  try {
    const git = which('git');
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

async function viaGit({ git, repo, ref, sourcePath, work }) {
  const clone = path.join(work, 'repo');
  const url = `https://github.com/${repo}.git`;
  log.info(`Fetching via git sparse-clone (${repo}@${ref}) ...`);

  const base = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse'];

  if (isSha(ref)) {
    // --branch does not accept a commit sha, so clone the default branch and
    // fetch the exact commit.
    await expect(run(git, [...base, url, clone]), `git clone ${url}`);
    await expect(run(git, ['-C', clone, 'fetch', '--depth', '1', 'origin', ref]), `git fetch ${ref}`);
    await expect(run(git, ['-C', clone, 'checkout', '--quiet', 'FETCH_HEAD']), `git checkout ${ref}`);
  } else {
    await expect(
      run(git, [...base, '--branch', ref, url, clone]),
      `git clone ${url} (branch ${ref})`,
    );
  }

  await expect(
    run(git, ['-C', clone, 'sparse-checkout', 'set', sourcePath]),
    `git sparse-checkout set ${sourcePath}`,
  );

  const dir = path.join(clone, ...sourcePath.split('/'));
  if (!isDirNonEmpty(dir)) {
    throw new UserError(`Plugin folder '${sourcePath}' is empty or missing in ${repo}@${ref}.`);
  }
  log.debug(`${countFiles(dir)} files checked out`);
  return dir;
}

async function expect(promise, what) {
  const result = await promise;
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new UserError(`${what} failed (exit ${result.code}). ${detail}`.trim());
  }
  return result;
}

async function viaApi({ repo, ref, sourcePath, work, deps = {} }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const dest = ensureDir(path.join(work, 'plugin'));

  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  let tree;
  try {
    const res = await fetchImpl(treeUrl, { headers: ghHeaders(env) });
    if (!res.ok) {
      throw new UserError(
        `GitHub API request failed (${res.status} ${res.statusText || ''}).`.trim(),
        { hint: 'Install git and re-run for a reliable fetch, or set GITHUB_TOKEN.' },
      );
    }
    tree = await res.json();
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`GitHub API request failed: ${treeUrl}`, { hint: err.message });
  }

  if (tree.truncated) {
    log.warn('GitHub tree response was truncated; some files may be missing. Prefer git.');
  }

  const prefix = `${sourcePath}/`;
  const blobs = (tree.tree || []).filter((n) => n.type === 'blob' && n.path.startsWith(prefix));
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

module.exports = { materialize, viaGit, viaApi, DOWNLOAD_CONCURRENCY };
