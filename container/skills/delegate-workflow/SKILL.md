---
name: delegate-workflow
description: How to follow a YAML workflow on a Delegate task — read the current phase block, satisfy every done_definition, then emit phase_complete:<id> exactly once to advance. Use when your incoming context contains a `WORKFLOW PHASE` section. For task CRUD see delegate-tasks; for the deliverable push convention see delegate-deliverables.
---

# Workflow runner

When a Delegate task has a workflow attached, every poll injects a
`WORKFLOW PHASE` block at the top of your context. The block carries the
current phase's:

- `id` — the phase identifier (e.g. `01_reproduce`)
- `name` — short label
- `description` — what this phase exists to accomplish
- `done_definitions` — a numbered list of concrete things that MUST be
  true before you can advance
- `working_directory` — where you should run commands by default
- `additional_notes` — extra guidance, gotchas, "do not do" callouts

You are responsible for one thing: satisfy EVERY `done_definitions` item,
then emit the advance marker. Do not invent additional criteria. Do not
skip ahead. Do not "kind of" satisfy items.

## Reading `done_definitions`

Each entry is a concrete success criterion. Treat it the way you would
treat a checkbox on a code-review form. If the entry says "the regression
test fails on `main`", run the test on `main`, capture the failing output
verbatim, and reference that output in your reply. Do not assert success
without evidence.

If a `done_definitions` entry seems impossible (e.g. asks for a tool you
don't have), STOP and post a comment on the task explaining the blocker.
Do not paper over with a guess.

## Emitting the advance marker

Once every item is satisfied, emit a single line in your reply:

```
phase_complete:01_reproduce
```

(Replace `01_reproduce` with the actual phase id you just finished.)

Rules:

1. The marker is a literal substring `phase_complete:<phase_id>`. It must
   match the phase id from the `WORKFLOW PHASE` block exactly.
2. Emit it ONCE per phase completion. Repeating it in the same reply has
   no effect; repeating it across replies for an already-advanced phase is
   ignored by the parser but creates noise.
3. Put a brief summary of evidence above the marker so the human reading
   the conversation has context. Example:

   ```
   Reproduced the bug on `main` at SHA abc1234. Steps: ...
   Observed: 500 from /api/foo. Expected: 200.

   phase_complete:01_reproduce
   ```

4. Do NOT continue working past the marker in the same reply. The next
   phase's block lands on your next poll — pick it up there.

## `working_directory`

The phase declares a `working_directory` (often `.`). When you run shell
commands, default to this path unless the phase notes otherwise. This
keeps file references in your replies anchored — humans reading the trace
shouldn't have to guess which `src/` you meant.

## Terminal phase

The last phase id in the workflow's `phase_order` is terminal. When you
emit `phase_complete:<terminal_phase_id>`, the delegation transitions to
`completed` automatically — you do not need to call `task.complete`. Make
sure your final reply contains all deliverable references (branch URL,
test output, summary comment) BEFORE the marker.

## Common mistakes

- Emitting the marker mid-investigation because you "think" you're done.
  Read the `done_definitions` list a second time before emitting.
- Inventing `done_definitions` not in the block (over-engineering).
- Skipping `done_definitions` you find tedious (under-delivering).
- Continuing to work after emitting the marker.
- Emitting `phase_complete` without the colon and id, e.g. just
  `phase_complete` — the parser requires `phase_complete:<id>`.

## Where the workflow lives

Workflows are YAML files in DelegateAgent's `workflows/` directory. You
don't read them directly — Delegate fetches the workflow over HTTP and
injects only the current phase block into your context. If you genuinely
need the full workflow (rare), the platform exposes it at:

```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$AGENT_DROPLET_URL/workflows/<name>" | jq
```

(But that URL is for the platform, not the agent. Stick to the phase
block in your context.)
