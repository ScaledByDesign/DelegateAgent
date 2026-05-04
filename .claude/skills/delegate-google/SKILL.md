---
name: delegate-google
description: Access the requesting user's Google Calendar, Drive, Gmail, Meet, and Contacts via the Delegate integration proxy. Uses per-user OAuth — each user's own data.
---

# Google Workspace Access

Access the requesting user's Google services. The `userId` from the message context ensures you query **their** data, not a shared account.

All calls require:
```
-H "Authorization: Bearer $DELEGATE_API_TOKEN"
-H "Content-Type: application/json"
```

## What's supported

| Service | Endpoint | Auth |
|---|---|---|
| Gmail | `/api/agent/integrations/gmail/<action>` | per-user OAuth |
| Google Calendar | `/api/agent/integrations/google_calendar/<action>` | per-user OAuth |
| Google Drive | `/api/agent/integrations/google_drive/<action>` (alias `gdrive`) | per-user OAuth |
| Google Meet | `/api/agent/integrations/google_meet/<action>` | per-user OAuth |
| Google Contacts | `/api/agent/integrations/google_contacts/<action>` | per-user OAuth |

## Credential resolution order (workspace-scoped FIRST, then per-user fallback)

The proxy resolves Google credentials in this priority order — **workspace-scoped wins** so SaaS multi-tenancy stays clean:

1. **Workspace credentials** (`WorkspaceIntegration` row, provider=`google_drive`)
   - Service-account key + impersonation subject (preferred for SaaS)
   - OR workspace-saved OAuth refresh token (transitional)
   - One credential set per workspace, used by ALL agents in that workspace
   - Workspace A's agents see Workspace A's data only — never Workspace B's
2. **Per-user OAuth (legacy fallback)** — the requesting user's NextAuth Google connection
3. **Workspace owner's per-user OAuth (legacy fallback)** — workspace owner's NextAuth Google connection
4. **Workspace.googleAccountId linked account (legacy fallback)** — older single-account model

If none of the four paths resolve a fresh access token, the route returns 401 "No Google account available" with guidance: workspace admin should connect at the workspace level OR each user must connect their personal Google.

> **For SaaS isolation** the right answer is path 1. Paths 2–4 are kept for backward compatibility but should not be relied on for multi-tenant deployments.

### How a workspace admin connects Google at the workspace level

The workspace stores credentials in a `WorkspaceIntegration` row with `provider="google_drive"` (the existing enum slot). The credentials JSON expects either:

```json
{
  "serviceAccountKey": {
    "type": "service_account",
    "client_email": "...@<project>.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\n...",
    "...": "..."
  },
  "impersonateEmail": "user@workspace.com"
}
```

— OR (transitional) —

```json
{
  "refreshToken": "1//...",
  "clientId": "<oauth-client-id>",       // optional override
  "clientSecret": "<oauth-client-secret>" // optional override
}
```

Service-account is the **recommended** shape — domain-wide delegation gives the agent access to any workspace user's data without needing them to OAuth individually.

## Microsoft 365 / Office 365 — NOT supported

Delegate currently has **no** Microsoft integration. The following providers all return `400 Unsupported provider`:
- `microsoft`, `outlook`, `ms_calendar`, `ms365`
- `onedrive`, `sharepoint`
- `teams`, `exchange`

If the user asks about Outlook email, OneDrive files, Teams chat, or Exchange calendar, tell them Microsoft 365 isn't connected and offer the Google equivalent if they have a Google account. Don't pretend to access Microsoft services — the proxy will 400 and the request will fail.

## Google Calendar

**List events (next week):**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_calendar/list_events" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","timeMin":"2026-03-30T00:00:00Z","timeMax":"2026-04-06T00:00:00Z"}'
```

**Create event:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_calendar/create_event" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","summary":"Team Standup","start":"2026-04-01T09:00:00-05:00","end":"2026-04-01T09:30:00-05:00","attendees":["alice@example.com"]}'
```

**Find free time:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_calendar/find_free_time" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","date":"2026-04-01","durationMinutes":30}'
```

## Google Drive

**List recent files:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_drive/list_files" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","limit":20}'
```

**Search files:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_drive/search_files" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","query":"quarterly report"}'
```

**Get file content:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_drive/get_file" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","fileId":"FILE_ID"}'
```

## Gmail

**List recent messages:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/gmail/list_messages" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","limit":10}'
```

**Search inbox:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/gmail/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","query":"from:client@example.com subject:invoice"}'
```

**Send email:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/gmail/send_message" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","to":"recipient@example.com","subject":"Re: Project Update","body":"..."}'
```

## Google Meet

**Create instant meeting:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_meet/create_meeting" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","title":"Quick Sync"}'
```

## Google Contacts

**Search contacts:**
```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_contacts/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"USER_ID","query":"John"}'
```

## Important Notes

- **USER_ID** comes from the message context header (`USER_ID: cmmj...`). Always use the requesting user's ID.
- **Per-user OAuth**: Each user's Google tokens are used, so you only see THEIR calendar/drive/email.
- **Token refresh**: The Delegate server handles OAuth token refresh automatically.
- **Timezone**: Calendar times are in the user's configured timezone. Use ISO 8601 format.
- **Errors**: If you get `401`, the user needs to re-connect Google in Delegate Settings.
