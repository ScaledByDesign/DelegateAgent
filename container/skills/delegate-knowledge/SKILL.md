---
name: delegate-knowledge
description: Workspace knowledge base — search guidelines and constraints before starting work, save learnings after. Bearer-callable read + create via /api/agent/knowledge endpoints; richer mutations (update, link, tag) require a session and are documented here for reference.
---

# Knowledge Base

The workspace knowledge base stores **domain facts**, **processes**, **guidelines**, **constraints**, and **preferences**. Per `operational-rules`, **always search it before starting work** to find relevant rules — you may already have the answer.

Auth for everything in this skill: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`.

## What you can do via bearer (agent-callable)

| Operation | Endpoint | Notes |
|---|---|---|
| **Read context-linked entries** | `GET /api/agent/context/$TASK_ID` | Returns `knowledgeLinks` with the entries the user has explicitly attached to this task. Always start here. |
| **Search by query** | `GET /api/agent/knowledge/search?q=&taskId=` | Title-matches first, then content-matches. Cap `take` at 100. |
| **List by type** | `GET /api/agent/knowledge?taskId=&type=guideline` | Types: `domain`, `process`, `guideline`, `constraint`, `preference`. |
| **Create a learning** | `POST /api/agent/knowledge` | Records `userId` from the resolved workspace owner so the entry is visible to the team. |

## What requires a user session (NOT bearer-callable)

These exist as `/api/knowledge/*` (no `agent/` prefix) and are session-cookie gated. They return **307 redirect** if you call them with a bearer.

- `GET /api/knowledge/[id]` — fetch a single entry by id
- `PUT /api/knowledge/[id]` — update title/content/type
- `DELETE /api/knowledge/[id]` — delete
- `POST /api/knowledge/links` — create entry-to-entry link
- `GET /api/knowledge/[id]/related` — linked + suggested
- `GET /api/knowledge/tags` — tag aggregation
- `GET /api/knowledge/canvas` — canvas layout
- `POST /api/knowledge/sync-notion` — Notion sync trigger

If your work needs one of these, ask the user to do it via the WebOS Knowledge Base app.

## Quick Start — search before you work

```bash
# 1. Your task context already includes user-linked knowledge
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.knowledgeLinks'

# 2. Search for entries that might bear on this task
curl -s -G "$DELEGATE_URL/api/agent/knowledge/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "q=<task keywords>" \
  --data-urlencode "taskId=$TASK_ID" \
  --data-urlencode "take=20"

# 3. List all guidelines for the workspace
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "taskId=$TASK_ID" \
  --data-urlencode "type=guideline"
```

## Search

```bash
curl -s -G "$DELEGATE_URL/api/agent/knowledge/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "q=stripe webhook" \
  --data-urlencode "taskId=$TASK_ID"
```

Either `taskId` OR `workspaceId` is required (the route resolves the workspace owner from one of them). `take` capped at 100, default 30.

Returns `{ data: [{ id, title, type, content, scope, attachments, ... }], total: N }`. Title matches rank above content matches.

## List

```bash
# All entries for the task's workspace
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "taskId=$TASK_ID"

# Filter by type
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "taskId=$TASK_ID" \
  --data-urlencode "type=constraint"
```

Returns `{ data: [...], total: N }`. Sorted by `updatedAt DESC`.

## Create — save a learning

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Stripe webhook signature verification gotcha",
    "content": "Stripe-Signature header includes a timestamp; reject if older than 5 minutes. Use stripe.webhooks.constructEvent — never roll your own.",
    "type": "guideline",
    "taskId": "'"$TASK_ID"'"
  }'
```

Required: `title`, `content`, `type` (one of `domain`, `process`, `guideline`, `constraint`, `preference`), and **one of** `taskId`, `workspaceId`, `projectId` (so the route can resolve the workspace owner).

Optional: `scope` (`workspace` default | `project`), `source`, `sourceId`, `sourceUrl`.

Returns `201 Created` with the new entry row.

## When to write to the knowledge base

After every task, ask: *would future agents save time if they knew this?* If yes — save it.

| You discover... | Type | Title style |
|---|---|---|
| A surprising API behavior or undocumented limit | `constraint` | "Stripe rate-limits at 100 r/s on test keys" |
| A reusable approach that worked well | `process` | "How to add a new WebOS app (5 steps)" |
| A team rule or convention | `guideline` | "Always use `lib/api-response` helpers, never raw NextResponse" |
| Background context (people, naming, history) | `domain` | "MAIN project = monolith, SCALED = mobile fork" |
| User-specific preference confirmed in chat | `preference` | "User prefers commits direct to main, no PRs" |

Skip writing when:
- The fact is already in `delegate-context` task fields or memory
- It's session-specific scratch work (use `delegate-memory` instead)
- It's a one-off detail unlikely to recur

## Knowledge vs memory

| Surface | Scope | Audience | Use for |
|---|---|---|---|
| **Knowledge base** | Workspace / project | All users + agents | "How should we do X?" rules, constraints, processes |
| **Agent memory** | Per-task, per-agent | Agent sessions only | "What did I do last session?" progress, scratch |

If a learning will help future agents on **other** tasks, it goes in the knowledge base. If it's specific to this run, use `delegate-memory`.

## Errors

Standard matrix from `delegate-error-handling`:
- 400 → missing `q` (search) or missing both `taskId` + `workspaceId`
- 404 → workspace owner couldn't be resolved (taskId points to a task that's been deleted, or workspaceId doesn't exist)
- 401 → see `delegate-api` token-aliases
- 5xx → upstream DB; back off, retry once

## See also

- `delegate-context` — read the task's pre-attached `knowledgeLinks` first
- `delegate-memory` — session-scoped scratch (NOT for cross-task learnings)
- `delegate-projects` — project-level metadata + repo URL + tech stack
- `operational-rules` — "always search knowledge before starting work"
