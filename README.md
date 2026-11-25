# AutoGit Sync

Auto-create GitHub repositories and push error-free code straight from VS Code on `Ctrl+S`—no terminal Git commands required.

Built by **Akshay Kumar K N** for students and developers who want to build a consistent GitHub profile while focusing on coding.

## Features

- **Zero-Terminal Sync:** Press `Ctrl+S` and your code automatically pushes to GitHub after a short 10-second debounce.
- **Error-Gated Commits:** Pauses syncing automatically if your file has syntax or compiler errors so your GitHub only receives clean code.
- **Public / Private Repo Picker:** Choose repository visibility whenever you connect a new folder.
- **Single-File Support:** Set a default repository to auto-sync loose practice files without opening a folder.
- **Push Entire Folder:** Upload an existing project to GitHub in one single commit.
- **Optional AI Commit Messages:** Connect your own Gemini API key to generate clean Conventional Commit messages automatically.
- **Built-in Secret Protection:** Automatically skips `.env`, `node_modules`, build folders, and files over 5 MB.

## Quick Start

1. Open any project folder in VS Code.
2. Click **AutoGit: Click to Connect** in the bottom-left status bar.
3. Sign in with GitHub, enter a repository name, and choose **Public** or **Private**.
4. Code normally and press `Ctrl+S`—AutoGit syncs automatically once your file has zero errors.

## Commands (`Ctrl+Shift+P`)

- `AutoGit: Connect Folder to GitHub Repo`
- `AutoGit: Push Entire Folder to GitHub`
- `AutoGit: Set Default GitHub Repo (Single Files)`
- `AutoGit: Set Gemini API Key (AI Commit Messages)`
