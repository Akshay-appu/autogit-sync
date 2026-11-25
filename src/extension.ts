import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  getGitHubUsername,
  ensureRepoExists,
  pushFileToGitHub,
  pushFolderTreeToGitHub,
  FolderFile
} from './github';
import { generateCommitMessage } from './ai';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.expo',
  'out',
  'coverage'
]);

const MAX_FILE_BYTES = 5 * 1024 * 1024; // Skip files larger than 5 MB
const pendingTimers = new Map<string, NodeJS.Timeout>();

function isIgnoredName(name: string): boolean {
  if (IGNORED_DIRS.has(name)) {
    return true;
  }
  // Protect secret .env files while still allowing .env.example
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
    return true;
  }
  if (name.endsWith('.log') || name.endsWith('.vsix') || name === '.DS_Store') {
    return true;
  }
  return false;
}

function shouldIgnorePath(targetPath: string): boolean {
  return targetPath.split('/').some(part => isIgnoredName(part));
}

function collectProjectFiles(rootDir: string, currentDir = rootDir): FolderFile[] {
  const results: FolderFile[] = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (isIgnoredName(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProjectFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      if (stat.size <= MAX_FILE_BYTES) {
        const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        results.push({ relativePath, fullPath });
      }
    }
  }

  return results;
}

function getTargetPath(doc: vscode.TextDocument, isUsingDefaultRepo: boolean): string {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (folder) {
    const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath).replace(/\\/g, '/');
    if (isUsingDefaultRepo) {
      const folderName = path.basename(folder.uri.fsPath).replace(/\s+/g, '-');
      return `${folderName}/${rel}`;
    }
    return rel;
  }
  return `single-files/${path.basename(doc.uri.fsPath)}`;
}

async function pickVisibility(): Promise<{ label: string; isPrivate: boolean } | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Public', description: 'Visible on your profile — best for portfolio projects' },
      { label: 'Private', description: 'Only visible to you — best for personal or practice files' }
    ],
    { placeHolder: 'Choose repository visibility (applies if creating a new repo)' }
  );
  if (!choice) {
    return undefined;
  }
  return { label: choice.label, isPrivate: choice.label === 'Private' };
}

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'autogit-sync.connectRepo';
  statusBar.show();
  context.subscriptions.push(statusBar);

  function refreshStatusBar() {
    const hasFolder = Boolean(vscode.workspace.workspaceFolders?.length);
    const linkedRepo = hasFolder ? context.workspaceState.get<string>('linkedRepo') : undefined;
    const defaultRepo = context.globalState.get<string>('defaultRepo');

    if (linkedRepo) {
      statusBar.text = `$(check) AutoGit: ${linkedRepo}`;
    } else if (defaultRepo) {
      statusBar.text = `$(check) AutoGit: ${defaultRepo} (Default)`;
    } else {
      statusBar.text = '$(cloud-upload) AutoGit: Click to Connect';
    }
  }

  refreshStatusBar();

  // Command 1: Set global default repo for single files & unlinked folders
  const setDefaultCmd = vscode.commands.registerCommand('autogit-sync.setDefaultRepo', async () => {
    const currentDefault = context.globalState.get<string>('defaultRepo') || 'daily-vscode-code';
    const repoName = await vscode.window.showInputBox({
      prompt: 'Enter your default GitHub repository name (used for single files & unlinked folders)',
      value: currentDefault
    });
    if (!repoName) {
      return;
    }

    const visibility = await pickVisibility();
    if (!visibility) {
      return;
    }

    try {
      statusBar.text = '$(sync~spin) AutoGit: Setting default repo...';
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true
      });
      const username = await getGitHubUsername(session.accessToken);
      await ensureRepoExists(session.accessToken, username, repoName, visibility.isPrivate);

      await context.globalState.update('defaultRepo', repoName);
      refreshStatusBar();
      vscode.window.showInformationMessage(
        `Default repo set to github.com/${username}/${repoName} (${visibility.label})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusBar.text = '$(error) AutoGit: Setup Failed';
      vscode.window.showErrorMessage(msg);
    }
  });

  // Command 2: Connect current folder
  const connectCmd = vscode.commands.registerCommand('autogit-sync.connectRepo', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      await vscode.commands.executeCommand('autogit-sync.setDefaultRepo');
      return;
    }

    const defaultName = path.basename(folder.uri.fsPath).replace(/\s+/g, '-');
    const repoName = await vscode.window.showInputBox({
      prompt: 'Enter GitHub repository name for this folder (created automatically if new)',
      value: defaultName
    });
    if (!repoName) {
      return;
    }

    const visibility = await pickVisibility();
    if (!visibility) {
      return;
    }

    try {
      statusBar.text = '$(sync~spin) AutoGit: Connecting...';
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true
      });
      const username = await getGitHubUsername(session.accessToken);
      await ensureRepoExists(session.accessToken, username, repoName, visibility.isPrivate);

      await context.workspaceState.update('linkedRepo', repoName);
      refreshStatusBar();
      vscode.window.showInformationMessage(
        `Linked folder to github.com/${username}/${repoName} (${visibility.label})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusBar.text = '$(error) AutoGit: Connection Failed';
      vscode.window.showErrorMessage(msg);
    }
  });

  // Command 3: Push all existing files in the folder in one single commit
  const pushFolderCmd = vscode.commands.registerCommand('autogit-sync.pushFolder', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Open a project folder first to push all files.');
      return;
    }

    let repoName = context.workspaceState.get<string>('linkedRepo');
    if (!repoName) {
      await vscode.commands.executeCommand('autogit-sync.connectRepo');
      repoName = context.workspaceState.get<string>('linkedRepo');
      if (!repoName) {
        return;
      }
    }

    const files = collectProjectFiles(folder.uri.fsPath);
    if (files.length === 0) {
      vscode.window.showWarningMessage('No eligible files found in this folder.');
      return;
    }

    const confirm = await vscode.window.showInformationMessage(
      `Push ${files.length} files to "${repoName}" in 1 commit? (.env and node_modules are automatically skipped)`,
      { modal: true },
      'Push All Files'
    );
    if (confirm !== 'Push All Files') {
      return;
    }

    try {
      const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true
      });
      const username = await getGitHubUsername(session.accessToken);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `AutoGit: Pushing ${files.length} files to ${repoName}`,
          cancellable: false
        },
        async (progress) => {
          statusBar.text = `$(sync~spin) AutoGit: Uploading ${files.length} files...`;
          await pushFolderTreeToGitHub(
            session.accessToken,
            username,
            repoName!,
            files,
            'feat: upload project files via AutoGit',
            (uploaded, total) => {
              progress.report({
                message: `${uploaded}/${total} files uploaded`,
                increment: (5 / total) * 100
              });
            }
          );
        }
      );

      refreshStatusBar();
      vscode.window.showInformationMessage(
        `Done! Pushed ${files.length} files to github.com/${username}/${repoName}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusBar.text = '$(error) AutoGit: Folder Push Failed';
      vscode.window.showErrorMessage(`AutoGit folder push error: ${msg}`);
    }
  });

  // Command 4: Securely store Gemini API key
  const apiKeyCmd = vscode.commands.registerCommand('autogit-sync.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      prompt: 'Paste your Gemini API key from Google AI Studio (leave blank to disable AI commits)',
      password: true,
      ignoreFocusOut: true
    });
    if (key === undefined) {
      return;
    }

    if (key.trim() === '') {
      await context.secrets.delete('geminiApiKey');
      vscode.window.showInformationMessage('AutoGit: Gemini API key removed.');
      return;
    }

    await context.secrets.store('geminiApiKey', key.trim());
    vscode.window.showInformationMessage('AutoGit: Gemini API key saved! AI commit messages are active.');
  });

  // Listener: Auto-sync on Ctrl+S
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (doc.uri.scheme !== 'file') {
      return;
    }

    const hasFolder = Boolean(vscode.workspace.getWorkspaceFolder(doc.uri));
    const linkedRepo = hasFolder ? context.workspaceState.get<string>('linkedRepo') : undefined;
    const defaultRepo = context.globalState.get<string>('defaultRepo');

    const repoName = linkedRepo || defaultRepo;
    if (!repoName) {
      return;
    }

    const isUsingDefaultRepo = !linkedRepo;
    const targetPath = getTargetPath(doc, isUsingDefaultRepo);
    if (shouldIgnorePath(targetPath)) {
      return;
    }

    const errors = vscode.languages
      .getDiagnostics(doc.uri)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

    if (errors.length > 0) {
      statusBar.text = `$(warning) AutoGit: Fix ${errors.length} error(s) to sync`;
      return;
    }

    const existingTimer = pendingTimers.get(targetPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    statusBar.text = '$(clock) AutoGit: Syncing in 10s...';

    const timer = setTimeout(async () => {
      pendingTimers.delete(targetPath);
      try {
        const session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: false
        });
        if (!session) {
          statusBar.text = '$(warning) AutoGit: Sign in again';
          return;
        }

        const fileText = doc.getText();
        let message = `update: ${targetPath}`;
        const apiKey = await context.secrets.get('geminiApiKey');

        if (apiKey) {
          statusBar.text = '$(sparkle) AutoGit: Writing AI commit...';
          try {
            message = await generateCommitMessage(apiKey, targetPath, fileText);
          } catch {
            message = `update: ${targetPath}`;
          }
        }

        statusBar.text = '$(sync~spin) AutoGit: Pushing...';
        const username = await getGitHubUsername(session.accessToken);
        await pushFileToGitHub(
          session.accessToken,
          username,
          repoName,
          targetPath,
          fileText,
          message
        );

        statusBar.text = `$(check) AutoGit: ${message}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        statusBar.text = '$(error) AutoGit: Sync Failed';
        vscode.window.showErrorMessage(`AutoGit error: ${msg}`);
      }
    }, 10000);

    pendingTimers.set(targetPath, timer);
  });

  context.subscriptions.push(setDefaultCmd, connectCmd, pushFolderCmd, apiKeyCmd, saveListener);
}

export function deactivate() {}
