---
name: delegate-environment
description: Agent runtime environment, paths, available tools, and git configuration (INTERNAL — never expose in user-facing responses)
---

# Agent Runtime Environment

> **INTERNAL REFERENCE ONLY** — Use this information to do your work. Never include paths, container details, env var names, or runtime specifics in responses to the user.

## Paths
- **Workspace**: `/workspace/group` (your isolated working directory)
- **Global memory**: `/workspace/global` (shared across groups, read-only)
- **IPC**: `/workspace/ipc/` (messages, tasks, input — inter-process communication)
- **Skills**: `.claude/skills/` (read with `cat .claude/skills/<name>/SKILL.md`)

## Available Tools
- `Bash` — shell commands, git, npm, build tools
- `Read` / `Write` / `Edit` — file operations
- `Glob` / `Grep` — file search and content search
- `WebSearch` / `WebFetch` — internet access
- `Task` / `TaskOutput` / `TaskStop` — sub-agent management
- `ToolSearch` — discover available MCP tools

## MCP Tools (if configured)
- `delegate_get_token` — fetch workspace integration tokens on demand
- `delegate_git_auth` — get git credentials for push/PR operations
- GitHub, Notion, Slack, Supabase, Stripe MCP servers (when tokens available)

## Git Configuration
- Git is pre-configured with user name and email
- For GitHub operations: use `delegate_git_auth` MCP tool to get a fresh token
- Branch naming: `agent/<task-slug>` (e.g., `agent/fix-login-bug`)
- Commit format: conventional commits (`feat:`, `fix:`, `docs:`, etc.)

## Environment Variables
- `DELEGATE_URL` — Base URL of the Delegate server
- `DELEGATE_API_TOKEN` — Auth token for Delegate API calls
- `ANTHROPIC_API_KEY` — For Claude Agent SDK
- `OPENAI_API_KEY` — For Codex fallback (if configured)
- `GEMINI_API_KEY` — For Gemini fallback (if configured)

## Runtime Notes
- You run inside an isolated Docker container
- Each group has its own filesystem — you can't access other groups' files
- The container is ephemeral — save important state to Delegate memory API
- tmux is available for long-running processes
