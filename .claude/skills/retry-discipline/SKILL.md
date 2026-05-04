---
name: retry-discipline
description: Failure tracking rules and 4-level escalation protocol to prevent infinite loops
---

# Retry Discipline

## Rules
- Track every tool failure: (tool name, arguments, error message)
- If the **same tool with the same arguments** fails **2 times** → STOP using that tool/args combination
- If **total failures in this session** reach **10** → escalate to the next level

## 4-Level Escalation Protocol

### Level 1: Reflect
**Trigger**: 10 total failures
**Action**: Stop. Think about the root cause. What is fundamentally wrong with your approach? Write out the analysis, then try a different strategy.

### Level 2: Alternative Tools
**Trigger**: Continued failures after reflection
**Action**: Use completely different tools or methods. If `Write` fails, try `Edit`. If `Bash npm install` fails, try manual download. If a file path doesn't work, try a different path.

### Level 3: Save and Report
**Trigger**: Still failing after alternatives
**Action**: Save everything you've accomplished to memory via the Delegate API. Write a clear summary of what blocked you. Report the blocker in a task comment.

### Level 4: Graceful Exit
**Trigger**: All escalation exhausted
**Action**: Stop execution entirely. Report what was completed and what blocked you. Do NOT continue attempting the same failing approach.

## Self-Monitoring Checklist
Before each tool call, ask yourself:
- [ ] Have I tried this exact same thing before and failed?
- [ ] Am I in a loop doing the same thing repeatedly?
- [ ] Is there a simpler alternative approach?

## Common Failure Patterns

### Filesystem / shell
- File not found → check the path with `ls` first
- Permission denied → try `sudo` or different user
- Build fails → read the FULL error output before attempting a fix
- Test fails → read the assertion, don't just re-run
- Git conflict → resolve it, don't force push

### Delegate API + integrations (load `delegate-error-handling` for the full matrix)
- **401 on a route that should accept the bearer** → check `${#DELEGATE_API_TOKEN}`; if zero, your container has stale env, exit and let the orchestrator restart you
- **404 on `/api/agent/tasks/<id>` after a delete attempt** → the delete already succeeded; treat as success and move on
- **404 on `/api/agent/channel/reply` for a deleted task** → the task was deleted while your reply was in flight; this is benign, don't retry
- **409 with `approvalId` in body** → not a failure; load `delegate-approvals` and stop re-issuing the call
- **"API Error: Content block not found" from Bifrost** → session is corrupted, NOT retryable; save state via `delegate-memory` and exit
- **Anthropic 529 overloaded** → backoff 5s/30s/120s; if still overloaded after 3 attempts, save and report

## See also
- `delegate-error-handling` — bounded recovery recipes per error class
- `delegate-approvals` — what 409 + approvalId means
- `verification` — the verification step in the dev cycle
