---
name: delegate-deliverables
description: Canonical workflow for producing a deliverable on a Delegate task — where to write files, branch naming, git push via the credential helper, and registering an Artifact row so the UI evidence card renders.
---

# Delegate Deliverables — Canonical Artifact Workflow

> **INTERNAL REFERENCE ONLY** — Use this to do your work. Never expose paths, branch names, API details, or curl commands in user-facing responses.

Load this skill whenever the task asks for a brief, document, report, spec, code output, or anything else that should appear as an artifact in the Delegate UI evidence card. It covers:

1. Where to write files so they survive container exit
2. Directory layout convention
3. Branch naming
4. Step-by-step push workflow
5. Registering the artifact via the API so the UI card renders
6. Env vars available in the container
7. Troubleshooting

---

## 1. When to Use

Load this skill when the user asks for a **deliverable** — anything that produces a file or set of files that should persist and appear in the task's evidence panel:

- Briefs, docs, memos, reports, specs, PRDs, outreach messages
- Code diffs, patches, or generated source files
- Any output phrased as "write me a...", "produce a...", "generate a...", "create a brief/doc/plan"

If the task is conversational only (answering a question, clarifying scope) and produces no file, skip to section 5 and just reply without pushing.

---

## 2. Where to Write Files

**Critical rule: bare `/workspace/` is ephemeral — it is wiped on container exit.**

| Path | Persistent? | Use for |
|------|-------------|---------|
| `/workspace/group/` | **YES** — bind-mounted to host | ALL deliverable files |
| `/workspace/group/<repo>/` | **YES** | Deliverables inside a cloned repo |
| `/workspace/ipc/` | YES (IPC only) | Inter-process communication only — not for deliverables |
| `/workspace/` (bare root) | **NO** | Nothing you write here survives |
| `/tmp/` | **NO** | Ephemeral scratch only |

**Always write to `/workspace/group/`.**

If a repo is already cloned there (check with `ls /workspace/group/`), write inside that repo's `_agent-deliverables/` directory. If no repo exists, create the deliverable directly under `/workspace/group/` in the standard layout below.

---

## 3. Layout Convention

```
_agent-deliverables/
└── <TASK_PUBLIC_ID>-<slug>/
    ├── README.md              # Required: task ID, agent, build date, pipeline source
    └── <deliverable>.md       # The actual content file(s)
```

Example for task `MAIN-28`:
```
_agent-deliverables/MAIN-28-helpdesk-brief/
├── README.md
└── helpdesk-brief.md
```

**README.md template:**
```markdown
# <Title>

| Field | Value |
|-------|-------|
| Task ID | <TASK_PUBLIC_ID> |
| Internal ID | <TASK_ID> |
| Agent | DelegateAgent |
| Build date | <ISO date> |
| Pipeline | agent-deliverable/<TASK_PUBLIC_ID>-<slug> |

## Files
- `<deliverable>.md` — <one-line description>
```

---

## 4. Branch Naming

```
agent-deliverable/<TASK_PUBLIC_ID>-<short-slug>
```

Rules:
- Lowercase only
- Kebab-case slug (hyphens, no underscores)
- Slug is a 2-4 word summary of the deliverable type
- Keep branch name under 60 characters total

Examples:
```
agent-deliverable/MAIN-28-helpdesk-brief
agent-deliverable/MAIN-31-checkout-funnel-spec
agent-deliverable/BILL-7-stripe-webhook-prd
```

---

## 5. Step-by-Step Push Workflow

Before running git commands, confirm you have the task ID and know the repo path:

```bash
# Determine where you are
ls /workspace/group/

# Set variables from context (ID appears in the injected context header above your prompt)
TASK_PUBLIC_ID="MAIN-28"          # from "TASK: ..." line in context
TASK_ID="cmoxzqv9n0001ioizgmogi77y"  # from "ID: ..." line
SLUG="helpdesk-brief"             # choose a descriptive 2-4 word slug
BRANCH="agent-deliverable/${TASK_PUBLIC_ID}-${SLUG}"
DELIVERABLE_DIR="_agent-deliverables/${TASK_PUBLIC_ID}-${SLUG}"

# Move into the repo (adjust name to match what's in /workspace/group/)
cd /workspace/group/<repo-name>
```

**If no repo is cloned**, create the deliverable directly in /workspace/group/:
```bash
mkdir -p /workspace/group/_agent-deliverables/${TASK_PUBLIC_ID}-${SLUG}
cd /workspace/group
git init   # only if this is a fresh workspace with no repo
```

**Standard push workflow** (repo already cloned):

```bash
# 1. Start from a clean state on main
git fetch origin main
git checkout -B ${BRANCH} origin/main

# 2. Create deliverable directory
mkdir -p ${DELIVERABLE_DIR}

# 3. Write README.md
# (Use the Write tool to create ${DELIVERABLE_DIR}/README.md with the template from §3)

# 4. Write the actual deliverable
# (Use the Write tool to create ${DELIVERABLE_DIR}/<deliverable>.md)

# 5. Stage and commit
git add ${DELIVERABLE_DIR}/
git -c user.email=agent@delegate.ws \
    -c user.name="DelegateAgent" \
    commit -m "feat(deliverables): ${TASK_PUBLIC_ID} ${SLUG}"

# 6. Push — the credential helper runs automatically, no token handling needed
git push -u origin ${BRANCH}
```

The `.git-credential-helper.sh` is pre-configured in the repo's local git config. It calls the Delegate API to fetch a fresh per-workspace GitHub OAuth token. You do not need to touch it.

---

## 6. Register the Artifact in the UI

After pushing, register the artifact so the evidence card renders in the task view. The API creates both an `Artifact` row and a `v1 ArtifactVersion` containing the content.

**Required fields** (confirmed from `POST /api/artifacts` schema):

| Field | Type | Notes |
|-------|------|-------|
| `workspaceId` | string | Optional but strongly recommended for tenant scoping |
| `taskId` | string | Optional but links the artifact to the task UI card |
| `delegationId` | string | Optional — link to the active delegation |
| `agentProfileId` | string | Optional — your profile |
| `type` | enum | One of: `spec`, `prd`, `code_diff`, `draft`, `meeting_brief`, `outreach_message`, `report`, `dashboard` |
| `title` | string | Short display title |
| `sourceType` | enum | Default `agent_run`. Options: `agent_run`, `human`, `meeting`, `email`, `import`, `system` |
| `format` | string | Default `markdown` |
| `content` | string | **Required** — the full text content of the artifact |
| `summary` | string | Optional one-paragraph summary |

Pick the `type` that best matches the deliverable:

| Deliverable | Use `type` |
|-------------|-----------|
| Brief, memo, doc | `draft` |
| Product requirements | `prd` |
| Technical spec | `spec` |
| Code changes, patch | `code_diff` |
| Meeting notes, board brief | `meeting_brief` |
| Cold outreach, follow-up | `outreach_message` |
| Analytics, KPI summary | `report` |
| Dashboard design | `dashboard` |

**Registration curl:**

```bash
# Read the deliverable content into a variable first
CONTENT=$(cat ${DELIVERABLE_DIR}/<deliverable>.md)

curl -sS -X POST "$DELEGATE_URL/api/artifacts" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg workspaceId "$DELEGATE_WORKSPACE_ID" \
    --arg taskId "$TASK_ID" \
    --arg type "draft" \
    --arg title "MAIN-28 Helpdesk Operational Brief" \
    --arg content "$CONTENT" \
    --arg summary "Agent-produced brief covering helpdesk ops, escalation paths, and KPI targets for MAIN-28." \
    '{
      workspaceId: $workspaceId,
      taskId: $taskId,
      type: $type,
      title: $title,
      sourceType: "agent_run",
      format: "markdown",
      content: $content,
      summary: $summary
    }')"
```

**Why this matters:** The Delegate UI evidence card queries `TaskDelegation { Artifact[] }`. Without this POST, the card shows empty even if the branch was pushed successfully. The `content` field is required — the API creates a v1 `ArtifactVersion` row and sets `artifact.currentVersionId` in the same transaction.

> `$DELEGATE_WORKSPACE_ID` is injected by the container runtime. `$TASK_ID` and `$DELEGATION_ID` appear in the context header injected into the poll message — extract them before use.

---

## 7. Environment Variables in the Container

Variables injected at container spawn time:

| Variable | Always set? | Notes |
|----------|-------------|-------|
| `DELEGATE_URL` | Yes | Base URL, e.g. `https://delegate.ws` |
| `DELEGATE_API_TOKEN` | Yes | Bearer token for all API calls. Aliases: `DELEGATE_AGENT_TOKEN`, `DELEGATE_API_KEY` (same value) |
| `DELEGATE_AGENT_JWT` | When minted | Per-workspace short-lived JWT (preferred over `DELEGATE_API_TOKEN` when set). Expires ~1h. |
| `DELEGATE_WORKSPACE_ID` | Yes, if dispatch had workspaceId | Per-workspace scope. Use in all API calls that accept `workspaceId`. |
| `ANTHROPIC_API_KEY` | Yes | For Claude SDK |
| `OPENAI_API_KEY` | When configured | Codex fallback |

Variables you extract from context (NOT env vars — parse from the injected context header):

| Value | Where it appears in context |
|-------|----------------------------|
| `TASK_ID` | Line `ID: <taskId> \| Status: ...` in the context preamble |
| `TASK_PUBLIC_ID` | Line `TASK: <title>` + project prefix, or `TASK_PUBLIC_ID: MAIN-28` if injected |
| `DELEGATION_ID` | Not always present — fetch from task context API if needed |
| `AGENT_PROFILE_ID` | Not always present — fetch from task context API if needed |

**Shell pattern to use DELEGATE_AGENT_JWT when available:**

```bash
AGENT_AUTH="${DELEGATE_AGENT_JWT:-$DELEGATE_API_TOKEN}"
curl -H "Authorization: Bearer $AGENT_AUTH" "$DELEGATE_URL/api/artifacts" ...
```

**Fetching TASK_ID and DELEGATION_ID from the context API** (when not in preamble):

```bash
TASK_CONTEXT=$(curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq .)
DELEGATION_ID=$(echo "$TASK_CONTEXT" | jq -r '.task.delegations[0].id // empty')
AGENT_PROFILE_ID=$(echo "$TASK_CONTEXT" | jq -r '.task.delegations[0].agentProfileId // empty')
```

---

## 8. Troubleshooting

**Push fails: `fatal: could not read Username` or `Invalid username or token`**

The credential helper script calls the Delegate API to fetch a fresh OAuth token. If it fails:

```bash
# Test the helper manually
/workspace/group/workspace/.git-credential-helper.sh
# Should print: protocol=https / host=github.com / username=x-token / password=gho_...
```

If the token is empty, the workspace's GitHub integration may be disconnected. Check via:
```bash
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/integrations/token?provider=github&workspaceId=$DELEGATE_WORKSPACE_ID" | jq .
```

If `data.token` is null, escalate to the user — they need to reconnect GitHub in the Integrations settings.

**Push fails: `Permission denied` or `403`**

The GitHub token is scoped to the workspace's connected org/user. Confirm the repo belongs to the same org as the workspace's GitHub integration. Cross-org pushes are not supported.

**Artifact POST returns `400 Validation failed`**

Check the `type` field — it must be one of the 8 allowed values. `"deliverable"` and `"git_branch"` are NOT valid. Check `content` is present and non-empty.

**Artifact POST returns `401 Unauthorized`**

Check `${#DELEGATE_API_TOKEN}` > 0. If zero the container token is stale — restart the container.

**Directory already exists on the branch**

If the branch already exists with the same deliverable dir (from a prior partial run):

```bash
git fetch origin
git checkout ${BRANCH}  # don't -B — attach to existing
git pull origin ${BRANCH}
# Now write new/updated files and commit
```

Or use a unique suffix: `MAIN-28-helpdesk-brief-v2`.

**`jq: command not found`**

`jq` is available in the container. If missing, fall back to a heredoc:

```bash
curl -sS -X POST "$DELEGATE_URL/api/artifacts" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "'"$DELEGATE_WORKSPACE_ID"'",
    "taskId": "'"$TASK_ID"'",
    "type": "draft",
    "title": "My deliverable title",
    "sourceType": "agent_run",
    "format": "markdown",
    "content": "'"$(cat ${DELIVERABLE_DIR}/<deliverable>.md | sed "s/'/'\\\\''/g")"'"
  }'
```

---

## Quick Reference Checklist

Before closing the task:

- [ ] Files written to `/workspace/group/` (not bare `/workspace/` or `/tmp/`)
- [ ] `_agent-deliverables/<TASK_PUBLIC_ID>-<slug>/README.md` created
- [ ] Deliverable content file written
- [ ] Branch `agent-deliverable/<TASK_PUBLIC_ID>-<slug>` created from `origin/main`
- [ ] `git add` + commit + `git push -u origin <branch>` completed
- [ ] `POST /api/artifacts` returned 201 with artifact id
- [ ] Task marked done via `PATCH /api/agent/tasks/$TASK_ID` with summary comment

---

## See Also

- `delegate-environment` — runtime paths, available tools, env vars
- `delegate-tasks` — task lifecycle CRUD (mark done, post comments)
- `delegate-context` — load full task context before starting
- `delegate-error-handling` — recovery recipes for 401/404/429/5xx
- `delegate-channel` — heartbeat, progress events, worktree lifecycle
- `integration-apis` — full reference for GitHub, Drive, and other integration proxy actions
