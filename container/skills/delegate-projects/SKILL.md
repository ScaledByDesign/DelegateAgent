---
name: delegate-projects
description: Read project-level metadata (name, status, repo, branch, tech stack, member counts) for the project a task lives in. Bearer-callable read-only at /api/agent/projects/[id]. Mutations require a session and are documented here for reference. Load when you need to understand "where am I working?" beyond the immediate task.
---

# Projects

Tasks live inside projects, projects live inside workspaces. This skill is the bearer-callable view onto the **project** layer — the metadata you need to write code with the right repo / branch / conventions.

Auth for everything bearer-callable: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`.

## What you can do via bearer

| Operation | Endpoint | Notes |
|---|---|---|
| **Read project from task context** | `GET /api/agent/context/$TASK_ID` | Returns `project: { id, name, status }` plus `workspace`. Always start here. |
| **Read full project detail** | `GET /api/agent/projects/$PROJECT_ID` | Adds `repoUrl`, `repoBranch`, `techStack`, `vercelProjectId`, `tags`, `assignedMembers`, plus counts (clients, connections, scopes, tasks, projectAgents). |

## What requires a user session (NOT bearer-callable)

These are session-cookie gated and return 307 if you call them with a bearer. Ask the user to do these via the WebOS Projects app.

| Endpoint | What |
|---|---|
| `GET /api/projects/[id]` | Full session view (more fields than the agent route) |
| `PUT /api/projects/[id]` | Update name / repo / branch / tech stack / status |
| `DELETE /api/projects/[id]` | Delete project |
| `GET/POST/DELETE /api/projects/[id]/members` | Manage member list |
| `GET/POST/DELETE /api/projects/[id]/clients` | Manage clients |
| `GET/POST/DELETE /api/projects/[id]/scopes` | Manage scopes |
| `GET/POST/DELETE /api/projects/[id]/connections` | Manage external service connections (GitHub, Figma, Slack, Notion, Drive, Jira) |
| `GET/POST/DELETE /api/projects/[id]/agents` | Assign/remove project agents |
| `POST /api/projects/[id]/agents/assign-team` | Bulk-assign team |
| `POST /api/projects/[id]/link` | Link to another project |
| `GET/POST /api/projects/[id]/goals` | Project goals |
| `GET/POST /api/projects/[id]/ideation` | Ideation sessions |
| `POST /api/projects/[id]/ideation/run` | Run AI ideation |
| `GET /api/projects/[id]/roadmap` | Roadmap view |

## Quick start — read project before starting work

```bash
# 1. Pull the task's project from context (cheapest — already includes summary)
curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq '.project, .workspace'

# 2. If you need repo / branch / tech stack, fetch the full project
PROJECT_ID=$(curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/context/$TASK_ID" | jq -r '.project.id')

curl -s -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  "$DELEGATE_URL/api/agent/projects/$PROJECT_ID" | jq '.data'
```

Sample full-detail response:
```json
{
  "id": "cmnbmwzdy0001ztzcf2gjxs1l",
  "name": "Main",
  "description": "Main monolith for the product team",
  "status": "active",
  "color": "210 40% 50%",
  "icon": "📁",
  "tags": ["typescript", "next-app-router"],
  "assignedMembers": ["userId-1", "userId-2"],
  "repoUrl": "https://github.com/ScaledByDesign/Delegate",
  "repoBranch": "main",
  "techStack": "Next.js 14 + Prisma + Supabase",
  "vercelProjectId": "prj_...",
  "workspace": { "id": "...", "name": "...", "slug": "...", "userId": "..." },
  "counts": { "clients": 0, "connections": 3, "scopes": 4, "tasks": 27, "projectAgents": 6 },
  "createdAt": "2026-04-20T18:33:15.123Z",
  "updatedAt": "2026-05-04T05:15:42.000Z"
}
```

## When to load project metadata

| Situation | Action |
|---|---|
| User asks "what repo / branch?" | `repoUrl` + `repoBranch` from project detail |
| Writing code, need to match the project's stack | `techStack` field; cross-reference with `delegate-context.project` |
| User asks "who's assigned to this project?" | `assignedMembers` (just userIds — combine with workspace member list if you need names) |
| Deciding where a new task should live | Read the project counts; busy projects get more attention |
| Project has connections (GitHub etc.) | The full connection records require a session — ask the user to share or open the WebOS app |

## What this skill is NOT

- Not a full project-management surface. Mutations (create / update / delete / member changes / connection management / scopes / clients) are session-only by design — those touch shared state and the platform routes them through the UI's permission flow.
- Not a substitute for `delegate-context`. Always start there for the task → project → workspace chain in one call.
- Not where you find git credentials. For git push/PR ops use the `delegate_git_auth` MCP tool (see `delegate-environment`).

## See also

- `delegate-context` — single call returning task + project + workspace + knowledgeLinks
- `delegate-knowledge` — workspace knowledge entries (often project-scoped)
- `delegate-tasks` — task lifecycle inside the project
- `delegate-environment` — git credentials, container paths, env vars
