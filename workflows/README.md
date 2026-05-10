# Workflows

YAML workflow templates that augment task delegations with declarative
"definition of done". When a Delegate task has `workflowName` set, the
Delegate platform fetches the workflow from `GET /workflows/<name>` here and
injects the current phase's prompt block into the agent's context on every
poll.

Layout (Hephaestus split — one workflow per directory, one file per phase):

```
workflows/
  bug-fix/
    workflow.yaml              # top-level config
    phases/
      01_reproduce.yaml        # phase id "01_reproduce"
      02_locate_root_cause.yaml
      03_fix_and_test.yaml
      04_verify_and_commit.yaml
```

This is intentionally NOT a single flat YAML. The split makes per-phase
overrides (a future Phase 2: `WorkspaceWorkflowOverride`) trivial — overlays
target individual phase records or the top-level config independently
without touching the rest.

## `workflow.yaml` schema

```yaml
name: "Bug Fix"
description: "..."
has_result: true
result_criteria: |
  Multi-line success criteria. The Validator (Hephaestus Port 3) consumes
  this when deciding whether the workflow's terminal phase actually
  delivered.
on_result_found: "stop_all"
launch_template: |
  Phase 1 entry prompt. Templated variables ({{task.title}}, {{task.identifier}})
  are substituted when injecting into the agent context.
phase_order:
  - "01_reproduce"
  - "02_locate_root_cause"
  - "03_fix_and_test"
  - "04_verify_and_commit"
```

Required fields: `name`, `description`, `has_result`, `result_criteria`,
`on_result_found`, `launch_template`, `phase_order` (non-empty array of
unique phase ids that must each have a matching `phases/*.yaml` file).

Unknown top-level keys are rejected — schema drift fails fast at startup.

## `phases/NN_<id>.yaml` schema

```yaml
id: "01_reproduce"
name: "Reproduce the bug"
description: |
  Long-form description...
done_definitions:
  - "Concrete, verifiable thing 1"
  - "Concrete, verifiable thing 2"
working_directory: "."
additional_notes: |
  Additional guidance the agent gets after `description`...
outputs:
  - "thing produced 1"
next_steps:
  - "what comes next"
cli_tool: ""        # optional
cli_model: ""       # optional
```

Required fields: `id`, `name`, `description`, `done_definitions` (non-empty),
`working_directory`, `additional_notes`, `outputs`, `next_steps`.
Optional: `cli_tool`, `cli_model`.

`done_definitions` MUST be a list of concrete, verifiable strings. Validator
(Port 3) and Guardian (Port 5) iterate this array — each entry should pass a
"would a human reviewer recognise this as done?" sniff test. Avoid vague
items like "code is good".

## How agents advance phases

When the agent has satisfied every `done_definitions` entry for the current
phase, it emits a single line in its reply:

```
phase_complete:01_reproduce
```

Delegate's `app/api/agent/channel/reply/route.ts` parser detects this
marker, advances `Task.currentPhaseId`, and injects the next phase's prompt
block via `/api/agent/channel/post`. When the marker references the
terminal phase (last entry in `phase_order`), the delegation transitions to
`completed` through `transitionDelegationStatus`.

See `container/skills/delegate-workflow/SKILL.md` for the agent-side guide.

## Adding a new workflow

1. Create `workflows/<name>/workflow.yaml` and `workflows/<name>/phases/`.
2. Add at least one phase file. Phase id must match the filename stem
   convention (`NN_<id>.yaml`) and must appear in `phase_order`.
3. Run `npm test -- src/workflows/loader.test.ts` to confirm validation.
4. Either redeploy the agent (Caddy + post-deploy.sh) or hot-reload via
   `POST /workflows/reload` with the bearer token.
5. Reference from a Delegate Task by setting `workflowName: "<name>"` in
   the POST body of `/api/tasks` (the platform validates the name exists
   before accepting the row).

## Hot reload

`POST /workflows/reload` re-runs the loader and replaces the in-memory
cache. Bearer-gated like every other `/workflows` route. Useful for fixing
a typo in a phase description without a full droplet restart. Returns:

```json
{ "ok": true, "count": 2, "names": ["bug-fix", "second-workflow"] }
```

## HTTP API

| Method | Path                  | Purpose                                  |
| ------ | --------------------- | ---------------------------------------- |
| GET    | `/workflows`          | List workflows (name + phase summary)    |
| GET    | `/workflows/:name`    | Return `{ config, phases: Phase[] }`     |
| POST   | `/workflows/reload`   | Re-run the loader, replace cache         |

All routes require `Authorization: Bearer $DELEGATE_AGENT_TOKEN`.
