---
name: git-worktree
description: Rules for working in an isolated git worktree environment. Use whenever a task involves committing, pushing, or opening a PR.
---

# Git Worktree Environment

You are working in an **isolated git worktree** mounted at `/workspace`. It is a separate working tree branched from the main repository, locked to your dedicated branch (`agent/<slug>-<task-shortid>`). Multiple agents may be working on the same repo simultaneously in different worktrees.

## Authentication — already configured

A per-workspace git credential helper is pre-installed in this worktree by DelegateAgent. You do **not** need to set `GITHUB_TOKEN`, run `gh auth login`, or fetch a token yourself. Both `git` and `gh` commands resolve credentials automatically:

```bash
git push origin HEAD          # works
gh pr create --draft --base main  # works
```

If a push or PR creation fails with auth errors, the helper script could not reach the Delegate API — re-run after a brief retry, then report the blocker if it persists.

## Critical Rules

1. **Never checkout other branches** — your worktree is locked to your branch. Running `git checkout` to another branch will corrupt the worktree setup.

2. **Always commit frequently** — your changes only exist in this worktree until pushed. Commit after every meaningful change.

3. **Push your branch before reporting completion**:
   ```bash
   git add -A
   git commit -m "feat: <description of changes>"
   git push origin HEAD
   ```

4. **Create a draft Pull Request** when done:
   ```bash
   gh pr create --draft --title "<task title>" --body "<summary of changes>" --base main
   ```

5. **Pull base branch changes** if you need the latest:
   ```bash
   git fetch origin main
   git merge origin/main
   # Resolve any conflicts
   ```

## What NOT to Do

- ❌ `git checkout main` — will break the worktree
- ❌ `git branch -d` on your current branch
- ❌ `git worktree` commands — managed by the orchestrator
- ❌ Force-push to `main` — only push your agent branch
- ❌ Setting `GITHUB_TOKEN` or running `gh auth login` — the helper is already configured

## Workflow

```
1. Read CLAUDE.md for task context
2. cd /workspace
3. Make changes, test, verify
4. git add -A && git commit -m "..."
5. git push origin HEAD
6. gh pr create --draft --base main
7. Report completion with PR URL via /api/agent/callback
```

## Directory Structure (inside container)

```
/workspace/                  ← YOUR GIT WORKTREE (work here)
├── .git                     ← linked to shared bare clone
├── .git-credential-helper.sh ← managed by DelegateAgent — do not edit
└── ...                      ← repository files
```
