---
name: delegate-channel
description: Delegate Agent channel + runtime endpoints — heartbeat (liveness), channel/post (system message injection), channel/progress (live step updates for UI), channel/worktree (per-task workspace lifecycle). These are the operational endpoints the agent runtime calls directly, distinct from the user-facing tasks/memory APIs in delegate-api / delegate-tasks.
---

# Delegate Channel + Runtime API

These endpoints exist for the agent runtime to communicate liveness,
inject system messages, push fine-grained progress, and manage the
per-task worktree. **You usually don't call them by hand — the
DelegateAgent runtime + paperclip orchestrator emit them for you.**
This skill exists so you can recognize them in logs, debug routing
issues, and call them directly when scripting one-off ops.

All endpoints take `Authorization: Bearer $DELEGATE_API_TOKEN` (or any
of the alias names — see `delegate-api` for details).

## Heartbeat — `POST /api/agent/heartbeat`

Liveness ping. The runtime posts every ~60s during long-running
delegations so the orphan reaper can distinguish live work from stuck
work.

```bash
curl -X POST "$DELEGATE_URL/api/agent/heartbeat" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "delegationId": "<delegationId>",
    "checkpoint": {
      "currentStepIndex": 3,
      "completedStepIds": ["step-0","step-1","step-2"],
      "scratch": {"prCreated": "https://github.com/x/y/pull/42"}
    }
  }'
```

Body fields:
- `delegationId` (required) — the active delegation row to update
- `checkpoint` (optional) — combine the heartbeat with a checkpoint
  write (current step, completed steps, last artifact, scratch JSON).
  Without it the route just refreshes `lastHeartbeatAt`.

Errors:
- `404` — delegation not found or already terminal (don't retry; clean up)
- `401` — bearer rejected (see `delegate-api` token-aliases section)

## Channel post — `POST /api/agent/channel/post`

Inject a message into the delegate channel. The agent picks it up on
its next poll. Used by cron, system alerts, scheduled tasks, and
**agent-to-agent** orchestration where one agent triggers another.

```bash
curl -X POST "$DELEGATE_URL/api/agent/channel/post" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "delegate:task:<taskId>",
    "text": "Daily standup reminder",
    "agentProfileId": "<targetAgentProfileId>",
    "metadata": {"source":"cron"}
  }'
```

JID format mirrors the chat surface:
- `delegate:main` — global channel (default if `jid` omitted)
- `delegate:task:<taskId>` — task-scoped
- `delegate:conv:<conversationId>` — conversation-scoped
- `delegate:agent:<userId>` — agent-scoped

Returns `201 Created` with the persisted message id.

Use this **sparingly** — every post triggers a poll cycle and
potentially a container spawn. For human chat, the user sends through
`/api/integrations/delegate-agent/chat` instead.

## Channel progress — `POST /api/agent/channel/progress`

Push fine-grained step status into the chat UI without persisting a
full message. Used by the SDK runtime to draw the live step rail
(spinner → ✓ → "N steps completed" pill).

```bash
curl -X POST "$DELEGATE_URL/api/agent/channel/progress" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "delegate:task:<taskId>",
    "agentProfileId": "<agentProfileId>",
    "events": [
      {"type":"step.started","message":"Reading checkout.html","data":{"stepIndex":"3"}},
      {"type":"step.completed","message":"Edited checkout.html","data":{"stepIndex":"3"}}
    ]
  }'
```

Body:
- `jid` (required) — same JID format as channel/post
- `agentProfileId` (optional) — overrides the JID-resolved profile
- `events[]` — one or more `{type, data?, message}` records

Common event types: `step.started`, `step.completed`, `step.error`,
`tool.start`, `tool.end`, `info`. The route emits a LiveEvent of the
matching type so the UI's `StatusBar` (Phase 8 of agent-chat plan)
can render heartbeats without waiting for a full agent message.

If you're posting > 5 events per second, batch them — Vercel rate
limits may bite.

## Channel worktree — `POST/DELETE /api/agent/channel/worktree`

Per-task workspace lifecycle on the **droplet group-api** (port 3001).
Proxied here so the agent can call `$DELEGATE_URL` rather than reach
the droplet directly.

```bash
# Create or attach to a worktree for the current task
curl -X POST "$DELEGATE_URL/api/agent/channel/worktree" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder":"task-<taskId>","groupId":"<groupId>","branch":"agent/<task-slug>"}'

# Tear down when the task is done
curl -X DELETE "$DELEGATE_URL/api/agent/channel/worktree?folder=task-<taskId>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

Emits `agent.worktree.created` / `agent.worktree.removed` LiveEvents
so the UI can update the worktree indicator in real time.

You almost never call this directly — the orchestrator handles
worktree lifecycle. Reach for it only when debugging a stuck container
or scripting a manual cleanup.

## Channel poll + reply (FYI)

`GET /api/agent/channel/poll` and `POST /api/agent/channel/reply` are
the **runtime-only** path: the DelegateAgent process polls for new
user messages and posts agent replies. You as a skill consumer never
call these by hand — they're abstracted by the SDK. Documented here
just so logs and traces are decodable.

## Errors

All routes follow the same matrix as `delegate-error-handling`:
- 401 on a route that should accept bearer → check `${#DELEGATE_API_TOKEN}` is non-empty
- 404 → resource (delegation, worktree, jid) doesn't exist
- 400 → body validation (missing required field, malformed JID)
- 5xx → upstream service degraded (group-api, Inngest, Supabase Realtime)

## See also

- `delegate-environment` — the runtime context (paths, env vars, MCP tools)
- `delegate-api` — memory, web search, callback, dashboard, usage
- `delegate-tasks` — full task lifecycle CRUD
- `delegate-error-handling` — error class recovery recipes
- `progress-reporting` — when to emit progress events from your skill code
