---
name: self-critique
description: Red-team your own work before declaring it done. Verification ("did it build?") only catches mechanical failures — this skill catches the qualitative defects: security holes, edge cases, hardcoded values, missing tests, regression risk, scope creep. Load after `verification` passes and BEFORE the completion callback.
---

# Self-Critique — Red-Team Your Own Output

`verification` answers "did the build pass?" — a low bar. `self-critique` answers "would a senior reviewer ship this?" — the bar that matters.

Run this checklist after every non-trivial change, before emitting the
completion marker or hitting the callback endpoint. Treat your own work as
adversarial — what would a reviewer flag in PR?

## When to run

- ALWAYS before declaring a task complete on coded work.
- ALWAYS before pushing a deliverable branch or registering an Artifact.
- SKIP only for trivial single-line edits (typo fixes, config bumps).

## The Six-Question Audit

Walk through each question. For any "yes," fix before completing.

### 1. Did I solve the actual problem, or just the surface symptom?

Re-read the task description. If the user asked "why is X slow," did you
fix the slowness, or just add a loading spinner? If the bug is "users
can't log in," did you find the root cause or just retry the failing
call? Surface-fix work loops back to you within a day — slow it down now.

### 2. What inputs did I NOT test?

For every change, name the edge cases your verification did not cover:

- Empty arrays, empty strings, null/undefined, zero, negative numbers.
- Unicode, emoji, RTL text, very long inputs.
- Concurrent requests, race conditions (two users, two tabs).
- Network failure, DB timeout, third-party API 500.
- The user has no permission / has all permissions / is the workspace owner with no `WorkspaceMember` row (Delegate-specific gotcha).

If any of these would break the change, add a guard or test BEFORE
declaring done. Don't assume "the call site will handle it."

### 3. Are there hardcoded values that should be config?

Grep your diff for:

- URLs (`http://`, `https://`, IP addresses)
- API keys, tokens, secrets, passwords (even placeholders — they leak)
- Magic numbers (timeouts, limits, retries, port numbers)
- User IDs, workspace IDs, project paths
- `localhost`, `127.0.0.1`, dev-only references

Anything that varies between dev/staging/prod MUST come from an env var,
PlatformSetting, or config file — not be hardcoded.

### 4. What did I break?

If you modified a function, what called it before? Run:

```bash
# For TS/JS:
grep -rn "functionName" --include="*.ts" --include="*.tsx" .
# Or use gitnexus when available:
# gitnexus_impact target="functionName" direction="upstream"
```

For every caller, ask: "does my change preserve their assumptions?" Common
break patterns:

- Changed return type → callers expecting old shape now crash.
- Added a required parameter → all existing call sites are now broken.
- Tightened a validation → previously-valid inputs now reject.
- Changed an error path → callers catching specific error messages now miss.

### 5. Did I leak secrets or PII?

Scan your diff for:

- Tokens / keys committed to a file (env files, JSON configs, code).
- Real user emails, names, phone numbers in tests or seed data.
- Stack traces or error messages that include user data.
- Logs that print the entire request body / response.

If a secret slipped into a commit, **STOP** — do not push. Rewrite the
commit (`git reset`, redact, recommit) before going further.

### 6. Did I drift from the actual ask?

Re-read the task description once more. Did you:

- Implement the requested feature, OR build a different one because you
  thought yours was better?
- Refactor adjacent code that didn't need refactoring?
- Add abstractions / config options / feature flags the task didn't ask for?
- Write more tests than the task required, in unrelated areas?

Scope creep gets your work rejected — even when it's "improvement." Stay
in scope. If you saw something worth fixing, file a follow-up task.

## The One-Line Summary

After running the audit, write ONE LINE to yourself (and to the channel
if relevant):

> "I did X. I'm confident about Y. I am less confident about Z."

Naming the weak spots out loud forces honest self-assessment. If you
catch yourself writing "I'm confident about everything," that's a signal
you didn't audit hard enough — go back to question 1.

## Anti-Patterns

- ❌ Treating self-critique as performative checkbox-ticking. ("Yes I
  thought about edge cases" with no evidence is worse than skipping.)
- ❌ Critiquing only the code you wrote, not the system change it implies.
- ❌ Adding "// TODO: handle X" instead of handling X. The TODO will
  outlive you.
- ❌ Running self-critique then ignoring what you found.
- ❌ Spending more time critiquing than the task warranted (a 50-LOC bug
  fix doesn't need a 6-question audit on every question — pick the 2-3
  that apply).

## Pairing with other skills

| Phase | Skill | What it catches |
|---|---|---|
| Pre-work | `delegate-context`, `operational-rules` step 2 | Codebase patterns, conventions, prior art |
| During | `delegate-error-handling`, `retry-discipline` | Runtime failure modes |
| After build | `verification` | Mechanical correctness (build, tests, lint) |
| **After verification** | **`self-critique`** | **Qualitative defects, scope drift, regression risk** |
| Before commit | `commit-push-pr`, `delegate-deliverables` | Branching, push, artifact registration |
