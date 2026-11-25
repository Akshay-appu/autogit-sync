import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const LFS_THRESHOLD_BYTES = 95 * 1024 * 1024; // 95 MB (GitHub hard REST API limit is 100 MB)

export interface FolderFile {
  relativePath: string;
  fullPath: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function encodeRepoPath(repoPath: string): string {
  return repoPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'AutoGit-Sync-VSCode'
  };
}

async function githubFetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 5
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) {
      return res;
    }

    const retryable = [403, 429, 502, 503, 504].includes(res.status);
    if (!retryable || attempt === maxRetries) {
      const errText = await res.text();
      throw new Error(`GitHub API ${res.status}: ${errText}`);
    }

    const retryAfter = Number(res.headers.get('retry-after') || 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1500 * Math.pow(2, attempt);
    await sleep(waitMs);
  }
  throw new Error('GitHub request failed after maximum retries.');
}

async function getDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
  try {
    const res = await githubFetchWithRetry(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: buildHeaders(token)
    });
    const data = (await res.json()) as { default_branch?: string };
    return data.default_branch || 'main';
  } catch {
    return 'main';
  }
}

export async function getGitHubUsername(token: string): Promise<string> {
  const res = await githubFetchWithRetry('https://api.github.com/user', {
    headers: buildHeaders(token)
  });
  const data = (await res.json()) as { login: string };
  return data.login;
}

export async function ensureRepoExists(
  token: string,
  owner: string,
  repo: string,
  isPrivate: boolean
): Promise<void> {
  const headers = buildHeaders(token);
  const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (checkRes.ok) {
    return;
  }

  if (checkRes.status !== 404) {
    const errText = await checkRes.text();
    throw new Error(`Failed checking repo (${checkRes.status}): ${errText}`);
  }

  await githubFetchWithRetry('https://api.github.com/user/repos', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: repo,
      private: isPrivate,
      auto_init: false
    })
  });
}

export async function pushFileToGitHub(
  token: string,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  commitMessage: string
): Promise<void> {
  const headers = buildHeaders(token);
  const branch = await getDefaultBranch(token, owner, repo);
  const encodedPath = encodeRepoPath(filePath);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  let existingSha: string | undefined;
  const existingRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  if (existingRes.ok) {
    const existingData = (await existingRes.json()) as { sha?: string };
    existingSha = existingData.sha;
  }

  const body: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  await githubFetchWithRetry(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
}

function resolveWorkspaceRoot(firstFile: FolderFile): string {
  const normalizedRel = firstFile.relativePath.split('/').join(path.sep);
  if (firstFile.fullPath.endsWith(normalizedRel)) {
    return firstFile.fullPath.slice(0, firstFile.fullPath.length - normalizedRel.length).replace(/[\\/]+$/, '');
  }
  return path.dirname(firstFile.fullPath);
}

async function pushViaGitLfs(
  folderPath: string,
  owner: string,
  repo: string,
  branch: string,
  token: string,
  largeFiles: FolderFile[],
  commitMessage: string
): Promise<void> {
  const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  if (!fs.existsSync(path.join(folderPath, '.git'))) {
    await execFileAsync('git', ['init', '-b', branch], { cwd: folderPath });
  }

  await execFileAsync('git', ['lfs', 'install'], { cwd: folderPath });

  for (const file of largeFiles) {
    await execFileAsync('git', ['lfs', 'track', file.relativePath], { cwd: folderPath });
  }

  await execFileAsync('git', ['add', '-A'], { cwd: folderPath });

  try {
    await execFileAsync('git', ['commit', '-m', commitMessage], { cwd: folderPath });
  } catch {
    // Ignore if working tree has nothing new to commit
  }

  await execFileAsync('git', ['remote', 'remove', 'origin'], { cwd: folderPath }).catch(() => {});
  await execFileAsync('git', ['remote', 'add', 'origin', authUrl], { cwd: folderPath });
  await execFileAsync('git', ['push', '-u', 'origin', branch, '--force'], {
    cwd: folderPath,
    maxBuffer: 50 * 1024 * 1024
  });
}

export async function pushFolderTreeToGitHub(
  token: string,
  owner: string,
  repo: string,
  files: FolderFile[],
  commitMessage: string,
  onProgress?: (uploaded: number, total: number) => void
): Promise<void> {
  if (files.length === 0) {
    throw new Error('No files provided to push.');
  }

  const branch = await getDefaultBranch(token, owner, repo);

  // Automatically hand off to Git + Git LFS if any file exceeds 95 MB
  const largeFiles = files.filter((file) => {
    try {
      return fs.statSync(file.fullPath).size > LFS_THRESHOLD_BYTES;
    } catch {
      return false;
    }
  });

  if (largeFiles.length > 0) {
    const rootDir = resolveWorkspaceRoot(files[0]);
    await pushViaGitLfs(rootDir, owner, repo, branch, token, largeFiles, commitMessage);
    onProgress?.(files.length, files.length);
    return;
  }

  const headers = buildHeaders(token);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

  // Initialize empty repositories with the first file before using Git Trees API
  let refRes = await fetch(`${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`, { headers });
  let startIndex = 0;

  if (refRes.status === 404 || refRes.status === 409) {
    const firstFile = files[0];
    onProgress?.(1, files.length);
    const firstBase64 = fs.readFileSync(firstFile.fullPath).toString('base64');

    await githubFetchWithRetry(`${apiBase}/contents/${encodeRepoPath(firstFile.relativePath)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: commitMessage,
        content: firstBase64,
        branch
      })
    });

    if (files.length === 1) {
      return;
    }

    startIndex = 1;
    refRes = await githubFetchWithRetry(`${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`, {
      headers
    });
  } else if (!refRes.ok) {
    const errText = await refRes.text();
    throw new Error(`Failed reading branch ref (${refRes.status}): ${errText}`);
  }

  const refData = (await refRes.json()) as { object: { sha: string } };
  const latestCommitSha = refData.object.sha;

  const commitRes = await githubFetchWithRetry(`${apiBase}/git/commits/${latestCommitSha}`, {
    headers
  });
  const commitData = (await commitRes.json()) as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];

  for (let i = startIndex; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length);

    const base64Content = fs.readFileSync(file.fullPath).toString('base64');
    const blobRes = await githubFetchWithRetry(`${apiBase}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: base64Content,
        encoding: 'base64'
      })
    });

    const blobData = (await blobRes.json()) as { sha: string };
    treeItems.push({
      path: file.relativePath,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha
    });

    if (i < files.length - 1) {
      await sleep(150);
    }
  }

  const newTreeRes = await githubFetchWithRetry(`${apiBase}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems
    })
  });
  const newTreeData = (await newTreeRes.json()) as { sha: string };

  const newCommitRes = await githubFetchWithRetry(`${apiBase}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: commitMessage,
      tree: newTreeData.sha,
      parents: [latestCommitSha]
    })
  });
  const newCommitData = (await newCommitRes.json()) as { sha: string };

  await githubFetchWithRetry(`${apiBase}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommitData.sha })
  });
}