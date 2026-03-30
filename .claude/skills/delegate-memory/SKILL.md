---
name: delegate-memory
description: Session memory lifecycle — automatically load prior context on start, save learnings on exit. Persists knowledge across agent sessions per task.
---

# Session Memory Lifecycle

**CRITICAL: Follow this protocol on EVERY session.**

## On Session Start (ALWAYS do first)

Before doing ANY work, load prior context for this task:

```bash
# 1. Load task-specific memories
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "taskId=$TASK_ID" \
  --data-urlencode "limit=20" | jq '.data[] | {title, content, type}'

# 2. Search for related knowledge
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "query=<task title or key terms>" \
  --data-urlencode "limit=10" | jq '.data[] | {title, content}'
```

If memories exist, **use them** — don't redo work that was already done in a previous session.

## During Work (save as you go)

Save important discoveries, decisions, and progress IMMEDIATELY — don't wait until the end:

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "title": "<concise title>",
    "content": "<what you learned, decided, or built>",
    "type": "<type>"
  }'
```

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
    "taskId": "TASK_ID",
    "title": "Session summary — <date>",
    "content": "## What was done\n- <completed items>\n\n## What is left\n- <remaining items>\n\n## Key decisions\n- <decisions made>\n\n## Blockers\n- <any blockers>",
    "type": "process"
  }'
```

## Memory Search Patterns

```bash
# Search by keyword
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "query=authentication flow" \
  --data-urlencode "limit=5"

# Get all memories for a task
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "taskId=TASK_ID" \
  --data-urlencode "limit=50"

# Get project-wide knowledge
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "projectId=PROJECT_ID" \
  --data-urlencode "limit=20"
```

## Anti-Patterns (avoid these)

- **DON'T** skip memory check on start — you'll redo work
- **DON'T** save only at session end — if the session crashes you lose everything
- **DON'T** save vague entries like "worked on stuff" — be specific
- **DON'T** save full file contents — save paths and key patterns instead
- **DON'T** skip the session summary — the next session needs it
