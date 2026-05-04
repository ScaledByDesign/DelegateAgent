---
name: delegate-api
description: Delegate API endpoints for memory, tasks, web search, and completion callbacks
---

# Delegate API Reference

All endpoints require: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`

Or use the `delegate_get_token` MCP tool if available.

## Bearer token — env-var aliases

The container injects three env vars that all hold the **same** secret value:

| Name | When to use |
|------|-------------|
| `$DELEGATE_API_TOKEN` | **Preferred for skills.** All curl examples in this catalog use this. |
| `$DELEGATE_AGENT_TOKEN` | Canonical name (matches Delegate's server env). Use when integrating with code that already references this name. |
| `$DELEGATE_API_KEY` | Legacy alias kept for older container skills. Don't use in new code. |

If you see `Unauthorized` (401) on what should be a working endpoint, the **first thing** to check is whether the token var is empty (`echo ${#DELEGATE_API_TOKEN}` should show > 0). If it's zero you're on a stale container — restart it via the host runtime, don't try to chase it inside the container.

> **Never** hand the user a curl command with the bearer in plaintext. The token is yours, not the user's; it's not transferable to a browser session.

## Memory API

**Search** (always check before researching):
```bash
curl -G $DELEGATE_URL/api/agent/memory \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "query=<what you need>" \
  --data-urlencode "limit=10"
```

**Save** (after every task, bug fix, decision, or discovery):
```bash
curl -X POST $DELEGATE_URL/api/agent/memory \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"<concise title>","content":"<details>","type":"<type>"}'
```
Types: `domain` (facts), `process` (how-to), `guideline` (rules), `constraint` (limits)

## Task API

**Query tasks:**
```bash
curl -G $DELEGATE_URL/api/agent/tasks \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "status=in_progress,todo" \
  --data-urlencode "limit=10"
```

**Post progress comment:**
```bash
curl -X POST $DELEGATE_URL/api/agent/tasks/<taskId>/comments \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"Progress: completed X, now working on Y","isProgress":true}'
```

**Update task status:**
```bash
curl -X PATCH $DELEGATE_URL/api/agent/tasks/<taskId> \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done","comment":"What I completed"}'
```

**Delete a task** (use only when the user explicitly asks to delete, or the
task description says "safe to delete" — never delete by inference):
```bash
curl -X DELETE $DELEGATE_URL/api/agent/tasks/<taskId> \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```
Returns 204 on success, 404 if already gone, 401 if token is wrong.
Records sync deletions for any active Notion mappings; emits a
`task.updated` LiveEvent with `action: "deleted"` so the UI can
hide the row immediately.

## Web Access

**Search:**
```bash
curl -X POST $DELEGATE_URL/api/agent/integrations/web/search \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"search terms"}'
```

**Fetch page:**
```bash
curl -X POST $DELEGATE_URL/api/agent/integrations/web/fetch \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://...","maxLength":8000}'
```

## Dashboard & Analytics

The agent-facing dashboard + usage endpoints accept the same bearer
token as everything else here.

**Workspace dashboard snapshot** (`/api/agent/dashboard`):
```bash
curl -sG "$DELEGATE_URL/api/agent/dashboard" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

Returns aggregated agent monitoring data (originally built for the Clawket
mobile app). Used to be marked "session-only" in this skill — that was
wrong; it accepts bearer auth.

**AI usage by date range** (`/api/agent/usage`):
```bash
curl -sG "$DELEGATE_URL/api/agent/usage?startDate=2026-05-01&endDate=2026-05-04" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

Returns input/output token totals, cache read/write breakdown, and
cost per call site for the date window.

**Per-status task counts (without dashboard):** if you only need a
count, hit the tasks list with a status filter and read `total`:

```bash
curl -sG "$DELEGATE_URL/api/agent/tasks" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "status=in_progress" \
  --data-urlencode "limit=1" | jq .total
```

**Session-gated dashboards (NOT bearer-callable):** The richer
`/api/dashboard/stats` and `/api/dashboard/report` routes require a
NextAuth session cookie. Agents cannot call those directly — if you
need a weekly productivity report, ask the user to share it.

## Completion Callback

Call when task is fully done:
```bash
curl -X POST $DELEGATE_URL/api/agent/callback \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"...","summary":"<what you did>","tags":["needs-review"]}'
```
