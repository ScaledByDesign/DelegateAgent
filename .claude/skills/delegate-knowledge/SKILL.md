---
name: delegate-knowledge
description: Knowledge base operations — search, create, update, link, and tag knowledge entries. Use to find guidelines before starting work and document learnings after.
---

# Knowledge Base

The workspace knowledge base stores domain facts, processes, guidelines, and constraints. **Always search it before starting work** to find relevant rules and context.

Auth for all: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`

> **Note**: Knowledge endpoints use `auth()` session-based auth. Agents access knowledge
> through the integration proxy or via the task context API which returns `knowledgeLinks`.
> The examples below use the session-authenticated endpoints directly — when calling from
> an agent context, pass credentials appropriately.

## Quick Start — Check for Relevant Knowledge

```bash
# 1. Your task context already includes linked knowledge
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.knowledgeLinks'

# 2. Search for knowledge related to your task
curl -s -G "$DELEGATE_URL/api/knowledge/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "q=<task keywords>" \
  --data-urlencode "workspaceId=$WORKSPACE_ID"
```

## List Entries

```bash
# All entries for a workspace
curl -s -G "$DELEGATE_URL/api/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID"

# Filter by type
curl -s -G "$DELEGATE_URL/api/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "type=guideline"

# Filter by scope
curl -s -G "$DELEGATE_URL/api/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "scope=workspace"

# Paginate
curl -s -G "$DELEGATE_URL/api/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "take=20" \
  --data-urlencode "skip=0"
```

Returns: `{ data: [{ id, title, type, content, scope, workspaceId, projectId, source, sourceId, sourceUrl, attachments, createdAt, updatedAt }] }`

Types: `domain`, `process`, `guideline`, `constraint`

## Search Entries

```bash
curl -s -G "$DELEGATE_URL/api/knowledge/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "q=authentication flow" \
  --data-urlencode "workspaceId=$WORKSPACE_ID"
```

Returns: `{ data: [{ id, title, type, content, scope, attachments }], total: N }`

Results are ranked: exact title matches first, then content matches.

## Get Single Entry

```bash
curl -s "$DELEGATE_URL/api/knowledge/<entryId>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

Returns: `{ id, title, type, content, scope, workspaceId, projectId, source, sourceId, sourceUrl, createdAt, updatedAt }`

## Get Related Entries

```bash
curl -s "$DELEGATE_URL/api/knowledge/<entryId>/related" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

Returns: `{ linked: [{ id, title, type, content, scope, linkId, linkLabel, direction }], suggested: [{ id, title, type, content, scope }] }`

- `linked` — entries explicitly connected via knowledge links
- `suggested` — entries in the same scope/workspace that might be related

## Create Entry

```bash
curl -s -X POST "$DELEGATE_URL/api/knowledge" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "API rate limits for external providers",
    "content": "Google Calendar API: 1M queries/day. Drive: 12000 queries/user/minute...",
    "type": "constraint",
    "scope": "workspace",
    "workspaceId": "WORKSPACE_ID"
  }'
```

Body fields:
| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Short descriptive title |
| `content` | yes | Full knowledge content (markdown supported) |
| `type` | yes | `domain`, `process`, `guideline`, or `constraint` |
| `scope` | no | `workspace` (default) or `project` |
| `workspaceId` | no | Scope to a workspace |
| `projectId` | no | Scope to a project |
| `source` | no | Origin system (e.g., `agent`, `notion`, `manual`) |
| `sourceId` | no | ID in origin system |
| `sourceUrl` | no | URL in origin system |

## Update Entry

```bash
curl -s -X PUT "$DELEGATE_URL/api/knowledge/<entryId>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Updated content with new information...",
    "type": "guideline"
  }'
```

All body fields are optional — only provided fields are updated: `title`, `content`, `type`, `scope`, `workspaceId`, `projectId`.

## Link Knowledge Entries

```bash
# Create a link between two entries
curl -s -X POST "$DELEGATE_URL/api/knowledge/links" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "<entryId1>",
    "targetId": "<entryId2>",
    "label": "relates-to"
  }'

# List all links
curl -s "$DELEGATE_URL/api/knowledge/links" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"

# Delete a link
curl -s -X DELETE "$DELEGATE_URL/api/knowledge/links?id=<linkId>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

## Get Tags

```bash
curl -s -G "$DELEGATE_URL/api/knowledge/tags" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "workspaceId=$WORKSPACE_ID"
```

Returns: `{ data: { tags: [{ name: "deployment", count: 5 }, { name: "guideline", count: 12 }] } }`

Tags are extracted from `#hashtags` in content plus entry types. Sorted by count descending.

## When to Use Knowledge

### Before starting work
1. **Search for guidelines** — `GET /api/knowledge/search?q=<task topic>` to find rules and conventions
2. **Check constraints** — `GET /api/knowledge?type=constraint&workspaceId=...` for limits and blockers
3. **Read task knowledge links** — your task context includes `knowledgeLinks` with directly linked entries
4. **Check related entries** — `GET /api/knowledge/<id>/related` to discover connected knowledge

### During work
5. **Follow guidelines** — apply any guidelines/constraints found in the knowledge base
6. **Create entries for discoveries** — document patterns, gotchas, and API details as you find them

### After completing work
7. **Document what was learned** — create knowledge entries for new patterns, decisions, and solutions
8. **Link knowledge to tasks** — connect relevant entries for future reference
9. **Update outdated entries** — if you find stale information, update it

## Knowledge vs Memory

| Feature | Knowledge Base | Agent Memory |
|---------|---------------|-------------|
| **Scope** | Workspace/project-wide | Per-task, per-agent |
| **Audience** | All users and agents | Agent sessions only |
| **Persistence** | Permanent until deleted | Session-scoped, searchable |
| **Content** | Guidelines, processes, constraints | Progress, decisions, discoveries |
| **Use case** | "How should we do X?" | "What did I do last session?" |

**Rule of thumb**: If it helps future agents and users across tasks, put it in the knowledge base. If it is specific to this task session, use agent memory.
