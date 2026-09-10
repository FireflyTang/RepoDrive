---
name: repo-drive
description: Browse, download, upload, and rename files or directories in one preconfigured GitHub repository used as a file drive. Use when the user asks to inspect or transfer files in their RepoDrive repository; Windows cannot upload or rename.
---

# Repo Drive

Use the bundled `scripts/repodrive` launcher. RepoDrive reads its saved configuration; after it has been configured once, do not ask the user to repeat the repository and do not pass `--repo` unless the user explicitly requests a one-off override. If it is not configured yet, ask for the repository once and run `scripts/repodrive configure --repo owner/repository --branch main --json`. Never include a token in this command.

Authentication comes from `REPODRIVE_TOKEN`, or automatically from `gh auth token` when GitHub CLI is logged in. Never print, log, or place a token in command arguments.

## Operations

- Inspect: `scripts/repodrive info --json` or `scripts/repodrive list [remote-path] --json`.
- Download: `scripts/repodrive download <remote-path> --output <local-path> --json`. Directories retain their hierarchy and are not downloaded as archives. Check whether the destination exists because matching files are replaced.
- Upload on macOS or Linux: first list the remote parent and obtain user confirmation, then run `scripts/repodrive upload <local-file-or-directory> --path <remote-parent> --json`. Directories retain their name and hierarchy, skip `.git`, and are not compressed.
- Rename on macOS or Linux: first list the remote parent, check that the new name is unused, and obtain user confirmation immediately before running `scripts/repodrive rename <remote-path> <new-name> --json`. The second argument is a name only, not another path. Directory hierarchy is retained.
- Upload and rename on Windows are forbidden. Do not attempt workarounds, API calls, git pushes, or alternate tools. Windows permits only browsing, downloading, and explicit deletion through its dedicated client.

Report the final local path after downloads. For partial upload or rename failures, report which files completed and stop instead of retrying blindly.
