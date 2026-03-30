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
