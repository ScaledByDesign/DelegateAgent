---
name: delegate-memory
description: Session memory lifecycle — automatically load prior context on start, save learnings on exit. Persists knowledge across agent sessions via the unified memory surface (KnowledgeEntry + Forgetful semantic index).
---

# Session Memory Lifecycle

**CRITICAL: Follow this protocol on EVERY session.**

The memory surface is unified: every save writes to the workspace's
`KnowledgeEntry` table (durable, multi-tenant) AND indexes the row in
Forgetful for semantic recall. The `vault` tag is managed automatically by
the helper — you do not need to set it.

Two recall modes:

| Mode | Behavior | Use when |
|------|----------|----------|
| `recall` | **Semantic search** via Forgetful → joined to Prisma | Looking for prior decisions, related context, similar work |
| `curated` | Prisma-only, manually-authored entries (`source IS NULL`) | Browsing a structured knowledge base |
| `all` | Prisma-only, includes agent-generated entries | Full workspace memory dump |

## On Session Start (ALWAYS do first)

Before doing ANY work, recall prior context for this task:

```bash
# Semantic recall — find prior decisions, learnings, and constraints
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "query=<task title or key terms>" \
  --data-urlencode "mode=recall" \
  --data-urlencode "topK=20" | jq '.data.memories[] | {title, content, type, score}'
```

You can also resolve workspace from the task:

```bash
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "taskId=$TASK_ID" \
  --data-urlencode "query=<keywords>" | jq '.data.memories'
```

If memories exist, **use them** — don't redo work that was already done in a previous session.

## During Work (save as you go)

Save important discoveries, decisions, and progress IMMEDIATELY — don't wait until the end:

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "'$WORKSPACE_ID'",
    "taskId": "'$TASK_ID'",
    "title": "<concise title>",
    "content": "<what you learned, decided, or built>",
    "type": "domain"
  }'
```

The response is `{ data: { id, forgetfulMemoryId } }`. Both IDs are stable
references you can store and re-fetch later.

### What to Save

| Type | When to save | Example |
|------|-------------|---------|
| `domain` | Facts, API details, configs | "Supabase project uses RLS with service role key" |
| `process` | How-to steps, workflows | "Deploy: build → push → vercel deploy --prod" |
| `guideline` | Rules, patterns, conventions | "All API routes use apiSuccess/apiError helpers" |
| `constraint` | Limits, blockers, gotchas | "gpt-5.4-mini uses Responses API — incompatible with Bifrost" |

### Save triggers (do this immediately when any of these happen)

- **Bug fixed** → Save the root cause and fix
- **Decision made** → Save what was chosen and why
- **Pattern discovered** → Save the pattern for next session
- **Blocker hit** → Save what's blocked and what was tried
- **File structure learned** → Save the key paths and what they do
- **API/config discovered** → Save endpoints, keys, formats

## Before Session End (ALWAYS do last)

Before your final response, save a session summary:

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "'$WORKSPACE_ID'",
    "taskId": "'$TASK_ID'",
    "title": "Session summary — '$(date +%Y-%m-%d)'",
    "content": "## What was done\n- <completed items>\n\n## What is left\n- <remaining items>\n\n## Key decisions\n- <decisions made>\n\n## Blockers\n- <any blockers>",
    "type": "process"
  }'
```

## Search Patterns

```bash
# Semantic search across the workspace
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "query=authentication flow" \
  --data-urlencode "mode=recall" \
  --data-urlencode "topK=5"

# Curated knowledge browse (only manually-authored entries)
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "mode=curated" \
  --data-urlencode "topK=50"

# Dedicated semantic-search endpoint (POST — same backend, MCP-friendly contract)
curl -s -X POST "$DELEGATE_URL/api/agent/memory/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "workspaceId": "'$WORKSPACE_ID'", "query": "rate limits", "topK": 10 }'
```

## MCP Tools (if configured)

If the Delegate MCP server is registered, prefer these over raw curl:

- `delegate_recall_memory({ workspaceId?, taskId?, query, topK? })` — semantic search
- `delegate_save_memory({ workspaceId?, taskId?, title, content, type?, tag? })` — write

Both fall back to `WORKSPACE_ID` / `TASK_ID` env vars when args are omitted.

## Anti-Patterns (avoid these)

- **DON'T** skip memory check on start — you'll redo work
- **DON'T** save only at session end — if the session crashes you lose everything
- **DON'T** save vague entries like "worked on stuff" — be specific
- **DON'T** save full file contents — save paths and key patterns instead
- **DON'T** skip the session summary — the next session needs it
- **DON'T** pass `tag` unless you know what you're doing — the `vault` tag is the default and is managed by the helper
