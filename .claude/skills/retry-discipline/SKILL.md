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
- File not found → check the path with `ls` first
- Permission denied → try `sudo` or different user
- Build fails → read the FULL error output before attempting a fix
- Test fails → read the assertion, don't just re-run
- Git conflict → resolve it, don't force push
