---
name: delegate-approvals
description: How to react when a tool call gets blocked by the server-side confirm_action approval gate (HTTP 409 with approvalId). Distinguishes the platform-level gate (this skill) from the agent-emitted prose-only "Approval Required" pattern (see approval-gates skill). Load when you see 409 + approvalId in a response body, or when planning a side-effect tool call.
---

# Server-side Approval Gate

Delegate has a runtime gate that intercepts **side-effect tool calls** before they execute and asks the user to approve. This is a platform-level gate enforced by the `/api/agent/channel/reply` route — it is **not** something you opt into; the server detects side-effect intent and holds the call.

This skill explains how to behave once that gate fires. For high-risk operations you should pause on **before** issuing a tool call, see `approval-gates` instead — that's the proactive prose-emit pattern.

## What it looks like

When a side-effect tool is detected, the channel reply route returns:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "success": false,
  "error": "approval_required",
  "approvalId": "appr_...",
  "sideEffectTool": "delegate-google.send-email",
  "risk": "high",
  "reused": false
}
```

This is **not** an error. It is a **pause**.

## What to do — exactly

1. **Stop.** Do not retry the tool call. Re-issuing it just creates a duplicate held approval and you'll get 409 again.
2. **Save your state via `delegate-memory`** so a future session can pick up where you left off.
3. **Tell the user, briefly**, what action is held and that you're waiting. Example:

   > "Holding `send-email` for your approval — the server flagged it as a side-effect. I'll continue once you decide in the UI."

4. **Continue with non-side-effect work** in parallel if the task has multiple subtasks. Only the held tool is paused; the rest of your reasoning is fine.
5. **Watch task state** by polling `/api/agent/context/$TASK_ID` (every 30s+, not faster) for the next status transition:
   - Approved → the dispatcher auto-replays your held call. The replay produces a NEW reply that arrives via the normal channel. You do **not** re-issue the tool call.
   - Rejected (3 sequential rejections of related approvals) → delegation transitions to `failed` / `cancelled`. Stop work and report.

## What NOT to do

- ❌ Re-issue the same tool call. The held one is queued; a duplicate doesn't bypass the gate.
- ❌ Poll `/api/agent/approvals/$APPROVAL_ID` directly. That endpoint is session-gated (cookie auth), not bearer. You will get 401.
- ❌ Pretend the operation succeeded. The user will discover the discrepancy.
- ❌ Try to bypass the gate by formatting the tool call differently. The classifier looks at the underlying tool name, not the wrapper.

## Side-effect tools that trigger the gate

These are the operations that the gate currently classifies (see `lib/delegation/approval-gate.ts` for the full list):

- Sending email (`delegate-google.send-email`, equivalent Slack/Notion outbound)
- Posting to external services (Slack send, Twitter/X post, webhook fire)
- Pushing code (`git push`, especially to main / protected branches)
- Deploying (Vercel deploy, Cloudflare Workers publish)
- Payment / billing operations (Stripe charges, refunds)
- Bulk-deletion operations (mass delete)

Routine reads, reversible writes (file edits in a feature branch, draft PRs), and internal state changes (saving memory, posting comments) do **not** trigger the gate.

## Risk levels

The 409 body includes a `risk` field: `low | medium | high`. This is informational — it doesn't change your behavior, but you can mention it in your user-facing message:

> "The server flagged this as **high-risk** and is waiting for your approval."

## Idempotency / replay semantics

The held reply (your tool call args + the tool name) is persisted on the `AgentApproval` row. On approve, the dispatcher:
1. Sets `dispatchedAt` (so a duplicate approve doesn't fire twice)
2. Replays the held reply through `/api/agent/channel/reply` with the same args
3. The route now skips the gate (`reused: false → true`) and lets the reply through
4. Your normal reply pipeline runs (persistence + LiveEvent + agent message)

If `dispatchedAt` is already set when you check, the call already replayed. Don't re-issue.

## Multi-approval flows

Some workflows have several approval gates in sequence (e.g., deploy → run migration → send notification). Each gate is independent. Treat them serially: don't try to batch approvals or pre-approve future steps. The user will approve each in the UI as it surfaces.

## Common errors against the approval flow

- **409 on the SAME approval after user approved** — the dispatcher should have replayed; you're trying to re-issue. Stop.
- **409 referencing a different approvalId** — a new side-effect was flagged for a subsequent tool. Treat as a fresh gate.
- **404 on /api/agent/approvals/...** — agent endpoints don't exist for the approvals namespace under bearer auth. The session-gated UI is the only way to act on the approval.

## Reference

- Server: `app/api/agent/channel/reply/route.ts` (~line 165) — `requireApprovalIfSideEffect`
- Server: `lib/delegation/approval-gate.ts` — classifier + gate logic
- Server: `lib/delegation/approval-dispatcher.ts` — auto-replay on approve
- Companion skill: `approval-gates` — proactive prose-emit pattern for things you DECIDE are high-risk before calling
- Companion skill: `delegate-error-handling` — broader error matrix (this skill is the 409 deep-dive)
