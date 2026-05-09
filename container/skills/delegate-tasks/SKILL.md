---
name: delegate-tasks
description: Full task lifecycle via /api/agent/tasks — create, query, update, comment, subtask, delete. Use when the user asks anything task-related (create a task, mark this done, add a subtask, delete it, post a progress comment). For richer task context (deps, project, contacts) load delegate-context. For non-task API calls, see delegate-api.
---

# Tasks API

This skill is the canonical reference for everything the agent can do to a Delegate task. All endpoints take `Authorization: Bearer $DELEGATE_API_TOKEN`.

## Read

### List tasks (filter + paginate)
```bash
curl -G "$DELEGATE_URL/api/agent/tasks" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "status=todo,in_progress" \
  --data-urlencode "priority=high,critical" \
  --data-urlencode "limit=20"
```

Filters (all optional, repeat for OR within a key):
- `status` — comma-separated: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`
- `priority` — `none`, `low`, `medium`, `high`, `critical`
- `assignee` — email or user id
- `projectId`, `workspaceId`, `parentId`, `tag`
- `q` — full-text search across title/description
- `limit` (default 20, max 100), `cursor` (returned by previous page)

Response: `{ data: [task...], cursor, total }`.

### Get one task (with relations)
For a task you already know the id of, prefer **delegate-context** which returns subtasks + comments + dependencies + project + knowledge in one call. Only fall back to this when you need the raw row:
```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/tasks/$TASK_ID"
```

## Write

### Create a task
```bash
curl -X POST "$DELEGATE_URL/api/agent/tasks" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Write Stripe webhook handler",
    "description": "Idempotent + signature-verified.",
    "projectId": "<projectId>",
    "priority": "high",
    "tags": ["billing"]
  }'
```

Required: `title` AND one of (`projectId`, `workspaceId`, `parentId`).

If `parentId` is provided the new task inherits its parent's project and workspace and becomes a subtask in the hierarchy.

The route auto-generates a project-scoped identifier (e.g. `BILL-42`) — you don't pass it.

### Patch a task (status, priority, fields)
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in_progress",
    "priority": "high",
    "comment": "Picked this up after the Stripe spike landed"
  }'
```

Patchable fields: `status`, `priority`, `title`, `description`, `assignee`, `assigneeAgentId`, `tags`. Pass `comment` to attach a progress comment in the same call.

### Mark done (the common case)
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done","comment":"<what I completed>"}'
```

This auto-completes the parent task if all siblings are also `done` or `cancelled`.

### Delete a task
```bash
curl -X DELETE "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

Returns 204 on success. Records sync deletions for any active Notion mappings; emits a `task.updated action:"deleted"` LiveEvent. **Use only when** the user explicitly asks to delete OR the task description says "safe to delete" — never delete by inference.

## Comments

### Post a progress comment
```bash
curl -X POST "$DELEGATE_URL/api/agent/tasks/$TASK_ID/comments" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"Progress: completed X, now working on Y","isProgress":true}'
```

Equivalent action via PATCH (one-shot status + comment):
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"comment","text":"<comment>","author":"Agent"}'
```

## Subtasks

The PATCH endpoint exposes three subtask actions. Pick the one matching the user's intent.

### Add a subtask
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-subtask","text":"Add idempotency check"}'
```

### Toggle a subtask (done/undone)
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"toggle-subtask","subtaskId":"<subtaskId>","done":true}'
```

To get the `subtaskId` first, fetch task context via **delegate-context**.

## Common patterns

### "Move my todo task to in_progress and post a comment"
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress","comment":"Starting work now"}'
```

### "Create a follow-up task as a subtask"
```bash
curl -X POST "$DELEGATE_URL/api/agent/tasks" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Follow-up: rate-limit check\",\"parentId\":\"$TASK_ID\",\"priority\":\"medium\"}"
```

### "Assign this to a specific agent profile"
```bash
curl -X PATCH "$DELEGATE_URL/api/agent/tasks/$TASK_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assigneeAgentId":"<agentProfileId>"}'
```
This auto-wakes the assignee agent (paperclip enqueueWakeup), so the new agent picks up the task without you needing to nudge it.

## Errors

If a write returns non-2xx, load **delegate-error-handling**. Common cases for tasks:
- 401 → token alias issue (see delegate-api token-aliases section)
- 404 → task already deleted; treat as success for delete, escalate for update
- 409 → side-effect approval gate triggered (use delegate-approvals)

## What this skill is NOT

- It is not how you read full task context. Use **delegate-context** for `task + subtasks + comments + deps + project + knowledge + git` in one call.
- It is not how you create scheduled/recurring tasks. Use **delegate-cron**.
- It is not how you assign delegations to specific agents at runtime. The PATCH `assigneeAgentId` field works for that, but the broader "delegation" lifecycle (planner → executor → verifier) is in `lib/delegation/` and is platform-managed; you don't call it directly.
