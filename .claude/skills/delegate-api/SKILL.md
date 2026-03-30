---
name: delegate-api
description: Delegate API endpoints for memory, tasks, web search, and completion callbacks
---

# Delegate API Reference

All endpoints require: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`

Or use the `delegate_get_token` MCP tool if available.

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

> **Auth note**: Dashboard endpoints use `auth()` cookie-based sessions, not the agent bearer
> token. Agents cannot call them directly. To get workspace stats, query the underlying data
> via the Task and Agent APIs, or ask the user to fetch and share the dashboard data.
>
> If you need aggregate counts, use the Task API with status filters instead:

**Count tasks by status (agent-accessible alternative):**
```bash
# In-progress tasks
curl -sG "$DELEGATE_URL/api/agent/tasks" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "status=in_progress" \
  --data-urlencode "limit=1" | jq .total

# Done tasks
curl -sG "$DELEGATE_URL/api/agent/tasks" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  --data-urlencode "status=done" \
  --data-urlencode "limit=1" | jq .total
```

**If a user session is available** (e.g., in a server-side context or when testing with a
session cookie), the full dashboard endpoints return rich metrics:

```bash
# Workspace stats (tasks, meetings, AI usage, agent health, integrations)
# period: 1d | 7d | 30d (default) | 90d
curl -s -H "Cookie: next-auth.session-token=SESSION_TOKEN" \
  "$DELEGATE_URL/api/dashboard/stats?period=30d"

# AI-generated weekly productivity report
# Returns: { period, summary, highlights[], areasOfAttention[], recommendations[], metrics }
curl -s -H "Cookie: next-auth.session-token=SESSION_TOKEN" \
  "$DELEGATE_URL/api/dashboard/report"
```

Stats response fields (for reference when interpreting user-shared data):
- `totalTasks`, `completedTasks`, `overdueTasks`, `inProgressTasks`, `todoTasks`
- `meetingsThisWeek`, `totalConversations`, `pendingSuggestions`
- `aiCallLog` — `{ totalCalls, totalTokens, totalCostUsd, byCallSite[], byProvider[] }`
- `agents` — `{ total, active, running, successRate, totalRuns, failedRuns, totalCostCents }`
- `taskVelocity[]` — daily `{ date, completed, created }` for last 14 days
- `delegations` — `{ pending, running, failed, blocked, successRate }`
- `integrations[]` — per-provider `{ provider, status, lastSync, errorCount, recordsSynced }`
- `orchestrator` — `{ status, lastTickAt, isStalled, tickCount, errorCount }`

## Completion Callback

Call when task is fully done:
```bash
curl -X POST $DELEGATE_URL/api/agent/callback \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"...","summary":"<what you did>","tags":["needs-review"]}'
```
