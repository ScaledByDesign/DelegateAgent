---
name: delegate-error-handling
description: How to recognize and recover from common errors when calling Delegate, Bifrost, and integration APIs. Recipes for transient retries, permanent failures, and rate-limit backoff. Load when a tool call returns a non-2xx response, a curl exits non-zero, or you see "API Error" / "fetch failed" / "Content block not found".
---

# Error Handling Playbook

This catalog matches every error class to one specific recovery action. **Default to retry-then-escalate, never silent-retry-forever.** Per `retry-discipline`: max 3 attempts, then report to user.

## Decision flow

```
Got an error response.
├── HTTP 401 / 403   → see "Auth failures"
├── HTTP 404         → see "Resource not found"
├── HTTP 409         → see "Conflict / approval gate"
├── HTTP 429         → see "Rate limit / quota"
├── HTTP 5xx         → see "Server / upstream errors"
├── Network: timeout, ECONNREFUSED, DNS → see "Connectivity"
├── Bifrost: "API Error", "Content block not found"  → see "Bifrost transients"
└── Anything else    → log + escalate to user (don't loop)
```

## Auth failures (401, 403)

**Symptom:**
```json
{"success":false,"error":"Unauthorized"}
```

**Root cause is usually one of:**
1. Empty bearer token. Check `echo ${#DELEGATE_API_TOKEN}` — must be > 0.
2. Wrong token name. The container injects `DELEGATE_API_TOKEN`, `DELEGATE_AGENT_TOKEN`, and `DELEGATE_API_KEY` — all hold the same value. If you see 401 on a route that should accept the bearer, check you didn't typo into a fourth name (`DELEGATE_TOKEN`, `API_TOKEN`, etc.).
3. Stale container. If the host runtime updated the env recently, your in-flight container still has the old (empty) value. **Don't loop the curl** — exit and let the orchestrator restart you.
4. The endpoint is `auth()` cookie-gated, not bearer-gated. Examples: `/api/dashboard/*`, `/api/admin/*`. These are NOT agent-callable; ask the user to share the data.

**Recovery:**
- Verify token is non-empty.
- If empty: do not retry; report to user that the agent runtime has a stale env. They need to restart the container.
- If non-empty: re-read the route's auth requirement (`grep -n verifyAgentToken` near the handler). If it's session-gated, fall back to telling the user.

## Resource not found (404)

**Symptom:**
```json
{"success":false,"error":"Task not found"}
```

**Common cases:**
- Task was already deleted by you or a parallel process.
- ID is malformed (extra spaces, missing prefix, wrong cuid format).
- You're hitting `/api/agent/tasks/<id>` with `<id>` being a workspace id or project id.

**Recovery:**
- For deletions: 404 means **already gone**. Treat as success and move on; do not retry.
- For reads: validate the id shape (`cuid` is `^c[a-z0-9]{24}$`); if that's right and you still get 404, the resource was deleted upstream — report back to user.
- For writes: 404 = nothing to update. Don't retry; report.

## Conflict (409)

**Symptom:**
```json
{"error":"approval_required","approvalId":"...","sideEffectTool":"...","risk":"high"}
```

This is the **confirm_action** approval gate. The route held your tool call because it has a side effect (e.g., sending email, deploying, deleting external data). It is **not a failure** — it's a pause.

**Recovery:**
- Stop polling that endpoint.
- Call `delegate-approvals` skill to surface the approval to the user.
- Once approved, the dispatcher replays your held call automatically — you don't re-issue it.
- If rejected, your delegation transitions to `cancelled`; clean up and exit.

## Rate limit / quota (429)

**Symptom:**
```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

**Recovery:**
- Read `Retry-After` header. If present, sleep that many seconds (cap at 60s).
- If absent, exponential backoff: 1s → 4s → 16s, max 3 retries.
- After 3 backoffs, escalate. Do not run a 4th attempt.

```bash
# Example backoff loop
for delay in 1 4 16; do
  resp=$(curl -sS -w "%{http_code}" "$URL" ...)
  status=${resp: -3}
  if [[ "$status" != "429" ]]; then break; fi
  echo "rate-limited, sleeping ${delay}s"
  sleep "$delay"
done
```

## Server / upstream errors (5xx)

| Code | Meaning | Recovery |
|------|---------|----------|
| 500 | Generic server error | Retry once with same input. If it 500s again, escalate. |
| 502 | Bad gateway (Caddy/Vercel can't reach upstream) | Wait 10s, retry once. Persistent 502 = upstream is down; escalate. |
| 503 | Service Unavailable (often "No agent server configured") | Don't retry — read the error body for the specific reason and act. |
| 504 | Gateway timeout | Retry with the same input. If 504 repeats, the request is too slow — split into smaller chunks. |

## Connectivity (network errors)

**Symptoms:**
- `curl: (6) Could not resolve host`
- `curl: (7) Failed to connect`
- `curl: (28) Operation timed out`
- `fetch failed`

**Recovery:**
- DNS failure (curl 6): retry once after 2s. If it fails again, your container's DNS is broken — escalate.
- Connection refused (curl 7): the service is down. Don't retry > 2 times; escalate.
- Timeout (curl 28): increase `--max-time` to 60s and retry once. If still timing out, the work is genuinely too slow; report partial state.

## Bifrost transients ("API Error: Content block not found")

This is a **known transient** when an LLM session's tool-use block goes out of sync with what Bifrost's cache expects. It often appears after long sessions (50+ tool calls) or after a Bifrost restart.

**Recovery:**
- This error is **not retryable** mid-session — the session is corrupted.
- Save your progress so far via `delegate-memory` (so the next run has context).
- Report to the user: "Hit a transient gateway error after N tool calls. Progress saved. The next message you send will start a fresh session."
- Do NOT loop — looping just produces the same error.

If the error appears on the FIRST call (before any tool use), it usually means Bifrost itself is unhealthy. Wait 15s and retry once; persistent failure means escalate.

## Anthropic 529 / Overloaded

```json
{"type":"overloaded_error","message":"Overloaded"}
```

**Recovery:**
- Anthropic capacity is temporarily saturated.
- Backoff: 5s → 30s → 120s, max 3 retries.
- If still overloaded after 3, save progress and report; don't burn budget retrying.

## Postgres "too many connections"

Symptom in route response:
```
P2024: Connection pool timeout
```

This means Delegate's pgbouncer is saturated. Almost always transient (10-30s window).

**Recovery:**
- Sleep 10s, retry once.
- If it fails again, escalate — the platform may have a connection leak, your retry loop will only make it worse.

## Approval gate replay loop

If you keep getting 409 on the same tool call after the user approved:
- The dispatcher should auto-replay; you don't re-issue.
- If you ARE re-issuing, you're re-creating the same approval and getting 409 again. Stop, read `delegate-approvals` skill, wait for the LiveEvent.

## Universal "what to do" rules

1. **Read the error body** before deciding. JSON errors have an `error` string and often a `code` field; surface those in your retry decision.
2. **Distinguish transient (retry) from permanent (don't)**. 5xx + 429 + 502/504 + connectivity = transient. 4xx (except 429) = permanent.
3. **Record every retry in `delegate-memory`** so subsequent agents know about the failure pattern.
4. **Cap retries at 3 per failure class.** Per `retry-discipline`, the 4th attempt becomes user-facing escalation.
5. **Never silent-retry an idempotent destructive op.** If `DELETE /tasks/X` returns 502, the task may or may not be deleted — verify with a `GET` before retrying.

## What this skill does NOT do

- It does not handle business-logic errors (e.g., "task is in an invalid state for this transition") — those are domain-specific; consult the relevant skill.
- It does not auto-retry — every example here is intentionally bounded. **If you find yourself retrying more than 3 times, stop.**
