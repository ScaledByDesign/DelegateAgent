---
name: delegate-context
description: Fetch full task context from Delegate API — subtasks, comments, dependencies, project, contacts. Load on demand to save tokens.
---

# Task Context Loader

Load full context for your current task from Delegate. **Call this first** when you need to understand what you're working on.

## Quick Start — Full Context (ONE call)

```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq .
```

Returns everything in a single response:

| Field | What it contains |
|-------|-----------------|
| `task` | Title, description, status, priority, assignee, dates, tags, notes |
| `subtasks` | Checklist items with completion status |
| `comments` | Latest 20 comments (newest first) |
| `project` | Project name and status |
| `workspace` | Workspace name |
| `dependencies.blockedBy` | Tasks that must finish before this one |
| `dependencies.blocks` | Tasks waiting on this one |
| `labels` | Task labels with colors |
| `knowledgeLinks` | Knowledge entries linked to this task (id, title, type) |
| `delegations` | Last 5 delegation attempts and results |
| `contact` | Associated contact (name, email) |
| `children` | Child tasks in hierarchy |
| `parent` | Parent task if this is a subtask |

## Selective Loading

If you only need specific parts and want to minimize tokens:

**Task details only:**
```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '{task, subtasks}'
```

**Dependencies and blockers:**
```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.dependencies'
```

**Comments thread:**
```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.comments'
```

**Linked knowledge:**
```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.knowledgeLinks'
```

> **Tip**: `knowledgeLinks` returns id/title/type. For full content, use the Knowledge Base skill:
> `GET /api/knowledge/<id>` or search with `GET /api/knowledge/search?q=...`

## Update Task After Work

**Post progress comment:**
```bash
curl -X POST "$DELEGATE_URL/api/agent/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"Completed X, now working on Y","isProgress":true}'
```

**Update status:**
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done","comment":"Summary of what was done"}'
```

**Check off subtask:**
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"toggle-subtask","subtaskId":"<subtaskId>","done":true}'
```

## Git / Repository Access

If the task's project has a repository configured, the context response includes a `git` section:
```json
{
  "git": {
    "repoUrl": "https://github.com/org/repo",
    "branch": "main",
    "authHint": "Use delegate_git_auth MCP tool, or curl...",
    "configCommand": "git config --global credential.helper '!f() { ... }; f'"
  }
}
```

**To authenticate git (clone/push/PR):**

Option A — MCP tool (preferred):
```bash
# If delegate MCP server is configured, use the tool directly
delegate_git_auth
# It returns: token, username, and a git config command to run
```

Option B — API call:
```bash
TOKEN=$(curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/integrations/token?provider=github" | jq -r '.data.token')
git config --global credential.helper '!f() { echo "username=x-token"; echo "password='$TOKEN'"; }; f'
```

**Workflow after auth:**
```bash
git clone <repoUrl> /workspace/repo
cd /workspace/repo
git checkout -b agent/<task-slug>
# ... do work, commit ...
git push origin HEAD
gh pr create --draft --title "feat: ..." --body "..."
```

## When to Use

- **Always load at start** — Run the full context call before beginning work
- **Reload after changes** — If you modify subtasks/status, reload to confirm
- **Check blockers** — Before starting, verify nothing in `dependencies.blockedBy` is incomplete
- **Read comments** — Previous agents or users may have left instructions in comments
- **Check delegations** — See what previous agents attempted and their results
- **Check knowledge** — Review `knowledgeLinks` for guidelines and constraints relevant to this task. Search the knowledge base for additional context — see the `delegate-knowledge` skill.
- **Check git** — If `git` section exists, clone the repo and work on a feature branch
