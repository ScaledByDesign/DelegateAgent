---
name: session-memory
description: Persistent session memory via NOTES.md — maintains progress checkpoints across sessions
---

# Session Memory Protocol

You MUST maintain a `NOTES.md` file in your working directory throughout every session. This is your persistent memory — it survives between sessions and context window resets.

## On Session Start (ALWAYS do this first)

1. Look for an existing `NOTES.md` in the working directory
2. If it exists, **read it entirely** — it contains your previous progress
3. If it doesn't exist, create one with the template below

## During Work

Update `NOTES.md` after every significant milestone:
- Completing a subtask
- Discovering an important insight
- Encountering and resolving a blocker
- Making a design decision

## On Session End (ALWAYS do this last)

Before your final response, update `NOTES.md` with:
- What you accomplished this session
- Current state of the work
- Any unresolved issues
- Next steps for the next session

## NOTES.md Template

```markdown
# Session Notes

## Current Status
- **Task**: [task description]
- **Branch**: [git branch name]
- **Last Updated**: [ISO timestamp]
- **Overall Progress**: [X/Y subtasks complete]

## Completed Work
- [x] [description of completed item] — [date]
- [x] [description of completed item] — [date]

## In Progress
- [ ] [current item being worked on]
  - Progress: [what's been done so far]
  - Remaining: [what's left to do]

## Files Modified
| File | Change | Status |
|------|--------|--------|
| `src/example.ts` | Added auth handler | ✅ Verified |
| `src/routes.ts` | Updated routes | ⏳ Needs tests |

## Decisions Made
- **[Decision]**: [Rationale] — [Date]

## Blockers & Issues
- ⚠️ [Description of blocker] — [status: resolved/active]

## Key Learnings
- [Something discovered about the codebase]
- [Pattern that worked well]
- [Gotcha to remember]

## Next Steps
1. [First thing to do next session]
2. [Second thing]
3. [Third thing]
```

## Rules

1. **NEVER skip reading NOTES.md** at session start — it IS your memory
2. **NEVER skip updating NOTES.md** at session end — future you depends on it
3. Keep entries concise — bullet points, not paragraphs
4. Include file paths and branch names — be specific
5. If NOTES.md gets very long (>200 lines), archive old completed items to `NOTES-archive.md`
