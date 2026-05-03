---
name: integration-apis
description: Per-provider API patterns for workspace integrations (Google, GitHub, Notion, Slack, etc.)
---

# Integration APIs

Use the Delegate integration proxy or MCP tools to interact with workspace integrations.
Auth for all: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`

## Token Access (via MCP)
If the `delegate_get_token` MCP tool is available, use it to get fresh tokens:
```
delegate_get_token(provider: "github")    → { token: "ghp_..." }
delegate_get_token(provider: "notion")    → { token: "ntn_..." }
delegate_get_token(provider: "slack")     → { token: "xoxb-..." }
delegate_get_token(provider: "google")    → { token: "ya29...." }
```

## Integration Proxy (via curl)

All proxy requests: `POST $DELEGATE_URL/api/agent/integrations/<provider>/<action>`

### Google Calendar
```bash
# List events
curl -X POST $DELEGATE_URL/api/agent/integrations/google_calendar/list-events \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timeMin":"2026-01-01T00:00:00Z","timeMax":"2026-01-31T23:59:59Z"}'

# Create event
curl -X POST $DELEGATE_URL/api/agent/integrations/google_calendar/create-event \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Standup","startTime":"2026-01-15T09:00:00Z","endTime":"2026-01-15T09:30:00Z","attendees":["alice@example.com"]}'

# Update event
curl -X POST $DELEGATE_URL/api/agent/integrations/google_calendar/update-event \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"eventId":"abc123","updates":{"summary":"Updated title"}}'

# Delete event
curl -X POST $DELEGATE_URL/api/agent/integrations/google_calendar/delete-event \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"eventId":"abc123"}'

# Find free time
curl -X POST $DELEGATE_URL/api/agent/integrations/google_calendar/find-free-time \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timeMin":"2026-01-15T00:00:00Z","timeMax":"2026-01-15T23:59:59Z"}'
```

### Google Drive
```bash
# List files
curl -X POST $DELEGATE_URL/api/agent/integrations/google_drive/list-files \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":20}'

# Search files
curl -X POST $DELEGATE_URL/api/agent/integrations/google_drive/search-files \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"project proposal"}'

# Get file metadata
curl -X POST $DELEGATE_URL/api/agent/integrations/google_drive/get-file \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileId":"1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"}'

# Create Google Doc
curl -X POST $DELEGATE_URL/api/agent/integrations/google_drive/create-doc \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Meeting Notes 2026-01-15"}'
```

### Gmail
```bash
# List messages
curl -X POST $DELEGATE_URL/api/agent/integrations/gmail/list-messages \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"is:unread","limit":10}'

# Get message
curl -X POST $DELEGATE_URL/api/agent/integrations/gmail/get-message \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messageId":"17a3b8c9d0e1f234"}'

# Send message
curl -X POST $DELEGATE_URL/api/agent/integrations/gmail/send-message \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"recipient@example.com","subject":"Follow-up","body":"Hi, following up on..."}'

# Search inbox
curl -X POST $DELEGATE_URL/api/agent/integrations/gmail/search \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"from:alice@example.com subject:proposal"}'
```

### Google Meet
```bash
# Create meeting (generates Meet link via Calendar)
curl -X POST $DELEGATE_URL/api/agent/integrations/google_meet/create-meeting \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Team Sync","startTime":"2026-01-15T14:00:00Z","endTime":"2026-01-15T15:00:00Z","attendees":["alice@example.com","bob@example.com"]}'
```

### Google Contacts
```bash
# Search contacts
curl -X POST $DELEGATE_URL/api/agent/integrations/google_contacts/search \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"John Smith"}'

# List contacts
curl -X POST $DELEGATE_URL/api/agent/integrations/google_contacts/list \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":50}'
```

### GitHub (also available via MCP)

GitHub actions are **kebab-case** (`list-repos`, not `list_repos`). All write actions go through the proxy — never bake a GitHub token into the container or `git push` directly. The proxy holds the workspace-scoped token; the agent only sends intent.

```bash
# List repos
curl -X POST $DELEGATE_URL/api/agent/integrations/github/list-repos \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Create PR (assumes commits already pushed to <head> via update-file flow below)
curl -X POST $DELEGATE_URL/api/agent/integrations/github/create-pr \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner":"org","repo":"name","title":"feat: ...","head":"agent/feature","base":"main","body":"..."}'
```

**Self-modifying-code workflow** (proxy holds the token; agent never sees it):

```bash
# 1. Get current SHA of base branch
BASE=$(curl -s -X POST $DELEGATE_URL/api/agent/integrations/github/get-ref \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"taskId":"'$TASK_ID'","owner":"org","repo":"name","branch":"main"}' | jq -r '.data.sha')

# 2. Create a new branch
curl -s -X POST $DELEGATE_URL/api/agent/integrations/github/create-branch \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"taskId":"'$TASK_ID'","owner":"org","repo":"name","branch":"agent/cleanup","fromSha":"'$BASE'"}'

# 3. Read a file (returns sha + decodedContent)
EXISTING=$(curl -s -X POST $DELEGATE_URL/api/agent/integrations/github/get-file \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"taskId":"'$TASK_ID'","owner":"org","repo":"name","path":"src/x.ts","branch":"agent/cleanup"}')

# 4. Update the file (pass sha to update; omit sha to create new)
curl -s -X POST $DELEGATE_URL/api/agent/integrations/github/update-file \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "taskId":"'$TASK_ID'","owner":"org","repo":"name",
    "path":"src/x.ts","content":"new file contents\n",
    "message":"chore: clean up","branch":"agent/cleanup",
    "sha":"'$(echo $EXISTING | jq -r '.data.sha')'"
  }'

# 5. (Optional) Delete a file
curl -s -X POST $DELEGATE_URL/api/agent/integrations/github/delete-file \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"taskId":"'$TASK_ID'","owner":"org","repo":"name","path":"src/old.ts","sha":"<blob-sha>","message":"chore: remove old","branch":"agent/cleanup"}'

# 6. Open PR
curl -s -X POST $DELEGATE_URL/api/agent/integrations/github/create-pr \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"taskId":"'$TASK_ID'","owner":"org","repo":"name","title":"chore: cleanup","head":"agent/cleanup","base":"main","body":"..."}'
```

### Notion
```bash
# Search pages (scoped to project-connected databases)
curl -X POST $DELEGATE_URL/api/agent/integrations/notion/search \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"meeting notes"}'

# Create page
curl -X POST $DELEGATE_URL/api/agent/integrations/notion/create-page \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"parentId":"<database-id>","parentType":"database","title":"New Page","content":"Page body text"}'

# Update page
curl -X POST $DELEGATE_URL/api/agent/integrations/notion/update-page \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pageId":"<page-id>","properties":{"Status":{"select":{"name":"Done"}}}}'

# Get page
curl -X POST $DELEGATE_URL/api/agent/integrations/notion/get-page \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pageId":"<page-id>"}'

# Create database entry
curl -X POST $DELEGATE_URL/api/agent/integrations/notion/create-database-entry \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"databaseId":"<db-id>","properties":{"Name":{"title":[{"text":{"content":"New item"}}]}}}'
```

### Slack
```bash
# Send message
curl -X POST $DELEGATE_URL/api/agent/integrations/slack/send-message \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"C0123456","text":"Task completed"}'

# List channels
curl -X POST $DELEGATE_URL/api/agent/integrations/slack/list-channels \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Get thread replies
curl -X POST $DELEGATE_URL/api/agent/integrations/slack/get-thread \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"C0123456","ts":"1234567890.123456"}'
```

## Action Name Reference

| Provider | Action Names |
|----------|-------------|
| `google_calendar` | `list-events`, `create-event`, `update-event`, `delete-event`, `find-free-time` |
| `google_drive` | `list-files`, `search-files`, `get-file`, `create-doc` |
| `gmail` | `list-messages`, `get-message`, `send-message`, `search` |
| `google_meet` | `create-meeting` |
| `google_contacts` | `search`, `list`, `get` |
| `notion` | `search`, `create-page`, `update-page`, `get-page`, `create-database-entry` |
| `slack` | `send-message`, `list-channels`, `get-thread` |
| `github` | **read**: `get-repo`, `list-repos`, `search-repos`, `list-issues`, `list-prs`, `get-pr`, `get-pr-diff`, `get-pr-files`, `get-file`, `get-ref`. **write** (proxy-mediated, no token in agent): `create-repo`, `create-issue`, `create-branch`, `update-file`, `delete-file`, `create-pr`, `create-pr-comment`, `create-pr-review` |

## When to Use MCP vs Curl
- **MCP tools**: Preferred when available — faster, typed, no curl boilerplate
- **Curl/integration proxy**: Fallback when MCP isn't configured, or for bulk operations
- **Direct Contacts API**: For CRM-enriched contacts (AI context, tonality, personality), use the Delegate Contacts API — see the `delegate-contacts` skill
