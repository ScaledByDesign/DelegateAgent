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
