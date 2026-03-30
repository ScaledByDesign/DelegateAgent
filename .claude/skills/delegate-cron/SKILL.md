---
name: delegate-cron
description: Create and manage scheduled tasks via Delegate's cron system. Schedule recurring agent work, sync jobs, and automated checks.
---

# Scheduled Tasks / Cron Jobs

Create recurring jobs that run automatically. Jobs can trigger agent work, HTTP calls, or AI prompts.

## List Current Jobs

```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/cron/jobs" | jq '.data[] | {id, name, schedule, handler, enabled, nextRun}'
```

## Create an Agent Scheduled Task

This is the main way to schedule recurring agent work. The cron engine injects a message into NanoClaw at the scheduled interval.

```bash
curl -s -X POST "$DELEGATE_URL/api/cron/jobs" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily task review",
    "description": "Check for overdue tasks and send a summary",
    "schedule": "0 9 * * *",
    "handler": "built-in:agent-task",
    "config": {
      "prompt": "Review all overdue tasks and send a summary of what needs attention today. Check each task status and flag any blockers.",
      "jid": "delegate:main",
      "taskId": "OPTIONAL_TASK_ID"
    },
    "enabled": true
  }'
```

### Schedule Formats

| Format | Example | Meaning |
|--------|---------|---------|
| Cron expression | `0 9 * * *` | Every day at 9:00 AM |
| Cron expression | `*/30 * * * *` | Every 30 minutes |
| Cron expression | `0 9 * * 1-5` | Weekdays at 9:00 AM |
| Shorthand | `5m` | Every 5 minutes |
| Shorthand | `1h` | Every hour |
| Shorthand | `24h` | Every 24 hours |

### Handler Types

| Handler | Purpose |
|---------|---------|
| `built-in:agent-task` | Inject prompt into NanoClaw for agent execution |
| `http` | Call any HTTP endpoint |
| `ai-prompt` | Stream an AI chat response |

## Create an HTTP Cron Job

```bash
curl -s -X POST "$DELEGATE_URL/api/cron/jobs" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Health check",
    "schedule": "*/5 * * * *",
    "handler": "http",
    "config": {
      "url": "https://example.com/api/health",
      "method": "GET"
    },
    "enabled": true
  }'
```

## Update a Job

```bash
curl -s -X PATCH "$DELEGATE_URL/api/cron/jobs/JOB_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

## Trigger a Job Manually

```bash
curl -s -X POST "$DELEGATE_URL/api/cron/jobs/JOB_ID/run" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

## View Run History

```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/cron/jobs/JOB_ID/runs" | jq '.data[] | {status, output, duration, ranAt}'
```

## Common Scheduled Agent Tasks

**Daily standup summary (9 AM):**
```json
{
  "name": "Daily standup",
  "schedule": "0 9 * * 1-5",
  "handler": "built-in:agent-task",
  "config": {
    "prompt": "Generate a daily standup: what was completed yesterday, what's planned today, any blockers. Check task status and recent commits."
  }
}
```

**Weekly report (Friday 5 PM):**
```json
{
  "name": "Weekly report",
  "schedule": "0 17 * * 5",
  "handler": "built-in:agent-task",
  "config": {
    "prompt": "Generate a weekly progress report: tasks completed, PRs merged, blockers resolved, priorities for next week."
  }
}
```

**Overdue task check (every 4 hours):**
```json
{
  "name": "Overdue checker",
  "schedule": "0 */4 * * *",
  "handler": "built-in:agent-task",
  "config": {
    "prompt": "Check for overdue tasks. For each, post a comment asking for status update."
  }
}
```
