---
name: delegate-knowledge
description: Knowledge base operations via the unified memory surface — search guidelines, create entries, link to tasks. Use to find rules before starting work and document learnings after.
---

# Knowledge Base

The workspace knowledge base stores domain facts, processes, guidelines, and constraints. **Always search it before starting work** to find relevant rules and context.

Auth for all: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`

The agent endpoints (`/api/agent/knowledge`, `/api/agent/memory`,
`/api/agent/memory/search`) accept bearer auth and route through the
unified `lib/memory` helper — the same code path the session-auth UI uses.

## Two recall modes

| Mode | Returns | Use when |
|------|---------|----------|
| `curated` (default for `/api/agent/knowledge`) | Manually-authored entries only (`source IS NULL`) | Browsing a structured knowledge base |
| `recall` | Semantic search via Forgetful | Finding "what did we decide about X" |
| `all` | Everything in the workspace | Full dump / admin views |

## Quick Start — Find Relevant Knowledge

```bash
# 1. Your task context already includes linked knowledge
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.knowledgeLinks'

# 2. Semantic search for related guidelines
curl -s -G "$DELEGATE_URL/api/agent/memory" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "query=<task keywords>" \
  --data-urlencode "mode=recall"
```

## List Entries (curated browse)

```bash
# All curated entries for a workspace (default mode)
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID"

# Filter by type
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "type=guideline"

# Switch mode to include agent-authored entries
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "mode=all"
```

Returns: `{ data: [{ id, title, type, content, scope, workspaceId, projectId, source, sourceId, sourceUrl, createdAt, updatedAt }], total }`

Types: `domain`, `process`, `guideline`, `constraint`, `preference`

## Search Entries

```bash
# Recall mode (semantic) — best for "find me prior work on X"
curl -s -G "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "mode=recall" \
  --data-urlencode "q=authentication flow"

# Or use the dedicated search endpoint (POST — MCP-friendly contract)
curl -s -X POST "$DELEGATE_URL/api/agent/memory/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "workspaceId": "'$WORKSPACE_ID'", "query": "authentication flow", "topK": 10 }'
```

Returns: `{ data: { memories: [...], source: "forgetful"|"prisma", unavailable?: true } }`

When `source: "prisma"` and `unavailable: true`, Forgetful was down and the
result is a lexical Prisma fallback (degraded recall — still useful but
less semantic).

## Create Entry

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "API rate limits for external providers",
    "content": "Google Calendar API: 1M queries/day. Drive: 12000 queries/user/minute...",
    "type": "constraint",
    "scope": "workspace",
    "workspaceId": "'$WORKSPACE_ID'"
  }'
```

Body fields:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Short descriptive title |
| `content` | yes | Full knowledge content (markdown supported) |
| `type` | yes | `domain`, `process`, `guideline`, `constraint`, or `preference` |
| `scope` | no | `workspace` (default) or `project` |
| `workspaceId` | one of these | Scope to a workspace |
| `taskId` | one of these | Resolves workspaceId from the task |
| `projectId` | one of these | Resolves workspaceId from the project |
| `source` | no | Origin system (default: `agent`) |
| `sourceId` | no | ID in origin system |
| `sourceUrl` | no | URL in origin system |

## When to Use Knowledge

### Before starting work

1. **Recall first** — `GET /api/agent/memory?mode=recall&query=<topic>` to find prior decisions
2. **Browse curated** — `GET /api/agent/knowledge?type=guideline` for hard rules
3. **Check task links** — your task context includes `knowledgeLinks` with directly linked entries

### During work

4. **Follow guidelines** — apply any guidelines/constraints found in the knowledge base
5. **Save discoveries** — POST `/api/agent/knowledge` (or `/api/agent/memory`) as you learn things

### After completing work

6. **Document patterns** — create entries for new patterns, decisions, and solutions
7. **Save a session summary** — see `delegate-memory` skill for format

## Knowledge vs Memory

The agent endpoints now share a single backend. The conceptual split is
about **defaults**, not data:

| | `/api/agent/knowledge` | `/api/agent/memory` |
|---|---|---|
| Default mode | `curated` (manually-authored) | `recall` (semantic) |
| Use case | "Show me the rules" | "Find prior work on X" |
| Storage | Same `KnowledgeEntry` table | Same `KnowledgeEntry` table |

You can switch modes on either endpoint via `?mode=recall|curated|all`.

## MCP Tools (if configured)

- `delegate_recall_memory({ workspaceId?, taskId?, query, topK? })` — semantic search across the workspace
- `delegate_save_memory({ workspaceId?, taskId?, title, content, type? })` — persist a learning
