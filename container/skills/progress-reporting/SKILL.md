---
name: progress-reporting
description: Structured progress events for real-time UI feedback — emit status updates during execution
---

# Progress Reporting Protocol

Emit structured progress updates during execution so the user can see what you're doing in real-time.

## Progress Event Format

Wrap status updates in `<progress>` tags. The UI parses these for real-time display.

### Event Types

```xml
<!-- When starting to think about a problem -->
<progress type="thinking">Analyzing the authentication flow in auth.ts</progress>

<!-- When editing a file -->
<progress type="file_edit" file="src/auth.ts" lines="45">Adding OAuth token refresh handler</progress>

<!-- When running a command -->
<progress type="command" cmd="npm test">Running test suite</progress>

<!-- When a command completes -->
<progress type="command_result" cmd="npm test" exit="0">12 tests passed</progress>

<!-- When creating a file -->
<progress type="file_create" file="src/middleware/rate-limit.ts">Creating rate limiter middleware</progress>

<!-- When committing -->
<progress type="git" action="commit">Committing: feat: add rate limiting</progress>

<!-- When work is complete -->
<progress type="complete" status="success">All changes verified and committed</progress>

<!-- When escalating a failure -->
<progress type="complete" status="failed">Build verification failed after 3 attempts</progress>

<!-- Heartbeat — emit every 30s during long operations -->
<progress type="heartbeat">Working on test suite fixes</progress>
```

## When to Emit Progress

| Activity | Event |
|----------|-------|
| Starting to analyze code | `thinking` |
| Before writing/editing a file | `file_edit` or `file_create` |
| Before running a shell command | `command` |
| After a shell command completes | `command_result` |
| Before git operations | `git` |
| Every 30 seconds during long operations | `heartbeat` |
| When task is done | `complete` |

## Rules

1. **Always emit a `thinking` event** before starting significant work
2. **Always emit a `complete` event** when done — the UI needs this to update status
3. **Keep descriptions short** — one line max, be specific about what file/component
4. **Don't spam** — one event per logical action, not per line of code
5. **Heartbeats during long waits** — if a command takes >30s, emit heartbeats so the user knows you're not stuck
6. Progress events are **separate from your response text** — they're metadata, not conversation

## Long-running tool operations (Hephaestus Port 4)

The host now captures Claude Agent SDK `tool_use` and `tool_result` blocks as
structured `AgentEvent` rows and streams them to the UI's "Trace" timeline in
real time. **Whenever a tool call would otherwise show as a stale-looking
`tool_use` waiting on its `tool_result`** (build commands >10s, large
downloads, slow integrations), emit a `progress` heartbeat so the timeline
shows continuous motion instead of a frozen-looking row.

```xml
<!-- Before kicking off a long-running command -->
<progress type="thinking">Running full test suite (~90s)</progress>

<!-- Every ~15s while waiting for the command -->
<progress type="heartbeat">Tests in progress: 142/300 passed</progress>

<!-- When the command completes -->
<progress type="command_result" cmd="npm test" exit="0">All 300 tests passed</progress>
```

Why this matters: the Trace UI ranks rows by `sequence`. A `progress` event
between the `tool_use` and `tool_result` keeps the most-recent-event indicator
moving, so users can tell the agent is alive — not stuck. The host's
`/api/agent/channel/event` endpoint persists every event with a 32KB payload
cap and server-side redaction (Authorization headers, AWS keys, JWTs, etc.),
so it's safe to mention what the command is doing in the heartbeat text.
