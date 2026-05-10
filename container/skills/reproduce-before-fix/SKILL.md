---
name: reproduce-before-fix
description: When a task is to fix a bug, reproduce it deterministically BEFORE attempting any fix. A fix without a confirmed reproduction is guesswork — the resulting "fix" rarely fixes anything and often masks the bug elsewhere. Load whenever the task description mentions "bug," "broken," "doesn't work," "regression," "error," "crashes," or a Sentry / error log is attached.
---

# Reproduce Before You Fix

A bug you can't reproduce is a bug you can't fix. You will only know
your patch actually works if you can flip the same input from "broken"
to "working." Skipping reproduction is the single most common failure
mode in agent-delivered bug fixes — the agent ships a plausible-looking
change that doesn't address the real defect, the user comes back with
the same complaint, and the loop costs everyone time.

## When to apply

ALWAYS, when the task description says any of:

- "bug," "broken," "doesn't work," "isn't working," "fails," "fail to"
- "regression," "regressed," "used to work"
- "crash," "crashes," "throws," "error," "500," "stack trace"
- Mentions a Sentry issue, error log, or pasted error message
- References a screenshot of an error state

If the task is **build a new feature**, skip this skill. Reproduction
makes sense for defects, not greenfield work.

## The Four Reproduction Steps

### 1. State the symptom precisely

Re-read the task. Write down ONE LINE: "When the user does X, Y happens
instead of Z." If you can't write that line clearly, the task description
is too vague — ask the user for specifics before guessing.

Examples of precise:

- "When user clicks 'Send' in compose modal, the modal closes but no email is sent."
- "When workspace owner with no `WorkspaceMember` row hits `/api/tasks`, the route returns 500."
- "When ConnectorSync row has `cursor=null`, the next sync fetches the entire history again instead of resuming."

Examples of imprecise (push back to user):

- "Emails are broken."
- "The dashboard is slow."
- "Something's wrong with the agent."

### 2. Reproduce on `main`

Before touching any code, run the reproduction against the current
`main` branch:

```bash
git fetch origin main
git log -1 origin/main          # record the SHA
# Now run the reproduction (curl, click sequence, test invocation)
```

You MUST observe the failure on `main` before proceeding. If you can't
reproduce on `main`:

- The bug is already fixed → confirm with user, close as resolved.
- The reproduction steps are wrong → ask user for more detail.
- The bug requires specific data/state you don't have → ask for it.

NEVER fix a bug you can't first reproduce. The "fix" will be guesswork
and the user has no way to verify it works.

### 3. Narrow the trigger

Once you can reproduce, peel away everything that isn't strictly
necessary to trigger the bug. A 200-line reproduction will hide the
defect; a 5-line reproduction reveals it.

- Strip optional parameters one by one — does the bug still fire?
- Reduce input size — does it still fire with 1 row instead of 1000?
- Remove preconditions — does it still fire without the user logged in?

What's left is the minimal reproduction. Write it down — you'll use it
as the regression test in step 4 of the fix.

### 4. Capture the artifact

Before writing the fix, save the minimal reproduction somewhere you
will use to verify the fix:

- **API bug**: a `curl` command that returns the wrong response.
- **UI bug**: a Playwright test or a click sequence + screenshot path.
- **Backend bug**: a unit test that fails on `main` (will pass after fix).
- **Data bug**: a SQL query that returns the wrong rows.

This artifact is non-negotiable. After the fix, you re-run THIS EXACT
artifact to prove the fix works. No artifact, no verifiable fix.

## Common Anti-Patterns

| Anti-pattern | Why it bites |
|---|---|
| "Looks like the issue — let me try this fix" without reproducing | You'll change code that wasn't the problem, then declare done. User comes back angry. |
| Reproducing on a stale local branch | Bug may already be fixed on `main`. You'll re-fix it badly. |
| Using a non-deterministic reproduction ("sometimes it fails") | You can't tell whether the fix worked or whether the bug just didn't fire this run. Make it deterministic first. |
| Using the bug's symptom as the test | "After my fix, the modal opens" doesn't prove the email actually sent. Test the actual broken behavior, not a proxy for it. |
| Skipping reproduction because "the fix is obvious" | Obvious fixes for non-obvious bugs are how you ship the wrong fix. |

## Intermittent / Flaky Bugs

Some bugs only fire 1 in 10 times. Don't fix them without first making
them fire reliably:

- Loop the reproduction 100x in a row — what's the failure rate?
- Are there ordering dependencies (test A must run before test B fails)?
- Is there a timing element (race, debounce, animation frame)?
- Is the bug load-dependent (only at >100 concurrent users)?

If you can't get to >50% reproduction rate, post a comment with what
you found and ask the user for more context. Don't ship a "fix" against
a bug that fires <50% of the time — you will not be able to verify the
fix worked.

## After You Fix

Re-run the reproduction artifact from step 4. The bug MUST flip from
firing to not-firing. Include the before/after in your completion report:

```
✅ Bug reproduced on main @ <sha>:
$ curl -X POST .../mail/send -d '{...}'
{"error": "..."}

✅ After fix on agent-deliverable/<slug>:
$ curl -X POST .../mail/send -d '{...}'
{"messageId": "..."}
```

Then add the reproduction as a regression test in the same commit. If
you didn't add a test, the next agent will reintroduce this bug within
a quarter.

## Pairing with other skills

| Phase | Skill |
|---|---|
| Identify bug-fix task | This skill (reproduce-before-fix) |
| Investigate root cause | `operational-rules` step 2 (GET BEARINGS) + `delegate-context` |
| Build the fix | normal coding loop |
| Run build/tests | `verification` |
| Audit before completion | `self-critique` |
| Ship | `commit-push-pr`, `delegate-deliverables` |
