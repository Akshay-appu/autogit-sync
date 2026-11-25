import * as fs from 'fs';

const GITHUB_API = 'https://api.github.com';

export interface FolderFile {
  relativePath: string;
  fullPath: string;
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'autogit-sync-vscode'
  };
}

export async function getGitHubUsername(token: string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/user`, { headers: headers(token) });
  if (!res.ok) {
    throw new Error('Failed to fetch GitHub profile');
  }
  const data = (await res.json()) as { login: string };
  return data.login;
}

export async function ensureRepoExists(
  token: string,
  owner: string,
  repoName: string,
  isPrivate: boolean
): Promise<void> {
  const check = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}`, {
    headers: headers(token)
  });

  if (check.ok) {
    return;
  }

  const create = await fetch(`${GITHUB_API}/user/repos`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      name: repoName,
      private: isPrivate,
      auto_init: true,
      description: 'Auto-synced from VS Code'
    })
  });

  if (!create.ok) {
    const err = await create.text();
    throw new Error(`Could not create repo: ${err}`);
  }
}

export async function pushFileToGitHub(
  token: string,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  commitMessage: string
): Promise<void> {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;

  let sha: string | undefined;
  const existing = await fetch(url, { headers: headers(token) });
  if (existing.ok) {
    const fileData = (await existing.json()) as { sha: string };
    sha = fileData.sha;
  }

  const base64Content = Buffer.from(content, 'utf8').toString('base64');
  const res = await fetch(url, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({
      message: commitMessage,
      content: base64Content,
      ...(sha ? { sha } : {})
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Push failed: ${err}`);
  }
}

export async function pushFolderTreeToGitHub(
  token: string,
  owner: string,
  repo: string,
  files: FolderFile[],
  commitMessage: string,
  onProgress?: (uploaded: number, total: number) => void
): Promise<void> {
  // 1. Get default branch and latest commit SHA
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: headers(token)
  });
  if (!repoRes.ok) {
    throw new Error('Could not read repository metadata');
  }
  const repoData = (await repoRes.json()) as { default_branch: string };
  const branch = repoData.default_branch || 'main';

  const refRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, {
    headers: headers(token)
  });
  if (!refRes.ok) {
    throw new Error(`Could not find branch "${branch}". Make sure the repo is initialized.`);
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const latestCommitSha = refData.object.sha;

  const commitRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${latestCommitSha}`,
    { headers: headers(token) }
  );
  if (!commitRes.ok) {
    throw new Error('Could not read latest commit');
  }
  const commitData = (await commitRes.json()) as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // 2. Upload all files as Git blobs in batches of 5
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  const batchSize = 5;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (file) => {
        const base64 = fs.readFileSync(file.fullPath).toString('base64');
        const blobRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          headers: headers(token),
          body: JSON.stringify({ content: base64, encoding: 'base64' })
        });
        if (!blobRes.ok) {
          const err = await blobRes.text();
          throw new Error(`Failed uploading ${file.relativePath}: ${err}`);
        }
        const blobData = (await blobRes.json()) as { sha: string };
        return {
          path: file.relativePath,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha
        };
      })
    );

    treeItems.push(...results);
    if (onProgress) {
      onProgress(Math.min(i + batchSize, files.length), files.length);
    }
  }

  // 3. Create a single tree and single commit pointing to all uploaded files
  const newTreeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
  });
  if (!newTreeRes.ok) {
    throw new Error('Failed to create Git tree');
  }
  const newTreeData = (await newTreeRes.json()) as { sha: string };

  const newCommitRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      message: commitMessage,
      tree: newTreeData.sha,
      parents: [latestCommitSha]
    })
  });
  if (!newCommitRes.ok) {
    throw new Error('Failed to create commit');
  }
  const newCommitData = (await newCommitRes.json()) as { sha: string };

  // 4. Move the branch pointer to the new commit
  const updateRefRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: 'PATCH',
      headers: headers(token),
      body: JSON.stringify({ sha: newCommitData.sha })
    }
  );
  if (!updateRefRes.ok) {
    throw new Error('Failed to update branch reference');
  }
}
