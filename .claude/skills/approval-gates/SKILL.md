---
name: approval-gates
description: Human-in-the-loop approval gates for high-risk operations — pause and ask before destructive actions
---

# Approval Gates

Before performing any high-risk operation, you MUST pause and request human approval. Do NOT execute the operation first and report afterward.

## Operations Requiring Approval

### 🔴 Always Require Approval
- Deleting files, directories, or databases
- Running database migrations (especially destructive ones)
- Deploying to production or staging
- Modifying environment variables or secrets
- Force-pushing to any branch
- Installing system-level dependencies (`apt install`, `brew install`)
- Changing authentication or authorization logic
- Modifying billing, payment, or financial code
- Any operation affecting user data at scale

### 🟡 Require Approval If Uncertain
- Major refactors affecting >5 files
- Changing API contracts that other services depend on
- Upgrading major dependency versions
- Changing CI/CD pipeline configuration
- Modifying infrastructure (Docker, cloud config)

### 🟢 No Approval Needed
- Creating new files
- Modifying existing code within scope of the task
- Running tests
- Creating branches
- Creating draft PRs
- Reading files and running non-destructive commands

## Approval Request Format

When you need approval, emit this EXACTLY:

```
🔒 **Approval Required**

**Action**: [Specific description of what you want to do]
**Files Affected**: [List of files/resources]
**Risk Level**: [Low / Medium / High / Critical]
**Reversible**: [Yes — explain how / No — explain why]
**Impact**: [What happens if this goes wrong]
**Alternative**: [Is there a safer way to achieve this?]

Waiting for your approval before proceeding...
```

## After Approval or Rejection

- **If approved**: Proceed with the action, then report results
- **If rejected**: Acknowledge, ask for alternative instructions if unclear
- **If no response within 10 minutes**: Do NOT proceed — report that you're waiting for approval and move on to other subtasks if available

## Rules

1. **NEVER perform a destructive action without approval** — even if you're confident it's correct
2. **Be specific** in your approval request — vague descriptions are not acceptable
3. **Suggest alternatives** when possible — "instead of deleting, I could archive"
4. **Don't batch approvals** — each high-risk action gets its own approval request
5. **Log all approvals** — include the approval decision in your NOTES.md
