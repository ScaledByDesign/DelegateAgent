---
name: verification
description: Self-healing verification loop — build/test after changes, auto-fix on failure, escalate after 3 attempts
---

# Self-Healing Verification Loop

Every code change MUST go through this verification loop before being reported as complete.

## The Loop

```
┌─────────────────┐
│  1. Write Code  │
└────────┬────────┘
         │
┌────────▼────────┐
│  2. Run Build   │──── ✅ Pass ──→ Step 3
└────────┬────────┘
         │ ❌ Fail
┌────────▼────────┐
│  Analyze Error  │
│  Fix & Re-run   │──── Loop (max 3 attempts)
└────────┬────────┘
         │ Still failing
         ▼
    🚫 Escalate
```

## Step-by-Step Protocol

### Step 1: After ANY code change, run verification

Choose the appropriate commands based on the project:

| Project Type | Build Check | Test Check |
|-------------|-------------|------------|
| Node.js/TS  | `npm run build` or `npx tsc --noEmit` | `npm test` |
| Python      | `python -m py_compile file.py` | `pytest` |
| Rust        | `cargo build` | `cargo test` |
| Go          | `go build ./...` | `go test ./...` |

### Step 2: If build/tests PASS ✅

Proceed to commit and report. Include verification evidence:
```
✅ Verified:
- Build: `npm run build` — exit code 0
- Tests: `npm test` — 12 passed, 0 failed
- Lint: `npm run lint` — no errors
```

### Step 3: If build/tests FAIL ❌

**Attempt 1**: Read the FULL error output. Fix the specific issue. Re-run.

**Attempt 2**: If same error persists, reconsider your approach. The error may indicate a deeper issue. Fix the root cause. Re-run.

**Attempt 3**: If STILL failing, try a completely different approach. Revert if needed and try again.

**After 3 failed attempts**: STOP and escalate.

### Step 4: Escalation Format

If verification fails after 3 attempts, report clearly:

```
🚫 Verification Failed (3 attempts exhausted)

**What I tried:**
1. [First approach and result]
2. [Second approach and result]  
3. [Third approach and result]

**Persistent error:**
[Exact error message]

**Root cause hypothesis:**
[Your analysis of why this is failing]

**Recommended next step:**
[What a human should look at]
```

## Mandatory Checks Before Claiming "Done"

| Claim | Required Proof |
|-------|---------------|
| "Tests pass" | Show `npm test` output with pass count |
| "Build succeeds" | Show `npm run build` with exit code 0 |
| "File created" | Run `cat` or `head` on the file to confirm |
| "Committed" | Show `git log -1 --oneline` |
| "Pushed" | Show `git push` output (no rejection) |
| "PR created" | Show the PR URL |

## Rules

1. **NEVER say "done" without running verification** — this is non-negotiable
2. **NEVER assume a build passes** — run it and check the output
3. **Read the FULL error** before attempting a fix — don't guess
4. **Track your attempts** — know when to escalate vs retry
5. **Include evidence** in your completion report — show the output
6. If unsure what test/build command to use, check `package.json` scripts first
