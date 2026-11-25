const GITHUB_API = 'https://api.github.com';

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
