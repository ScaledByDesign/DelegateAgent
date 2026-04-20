---
name: delegate-meetings
description: Access meetings, transcripts, action items, and AI-powered meeting intelligence
---

# Delegate Meetings API

All endpoints use NextAuth session auth — these are user-session endpoints, not agent-token endpoints.
The agent must operate under the user's session context (via the DelegateAgent channel USER_ID header) or use a session cookie forwarded by the Delegate proxy.

For direct HTTP calls from agent code, use:
```
-H "Authorization: Bearer $DELEGATE_API_TOKEN"
-H "Content-Type: application/json"
```

Base URL: `$DELEGATE_URL`

---

## List Meetings

**GET /api/meetings**

Returns meetings for the authenticated user, newest first.

```bash
# All meetings (default limit: 50)
curl -s "$DELEGATE_URL/api/meetings" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"

# Filtered by status
curl -s "$DELEGATE_URL/api/meetings?status=raw" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"

# Filtered by workspace and paginated
curl -s "$DELEGATE_URL/api/meetings?workspaceId=WORKSPACE_ID&take=20&skip=0" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status: `raw`, `processing`, `processed` |
| `workspaceId` | string | Scope to a specific workspace |
| `projectId` | string | Scope to a specific project |
| `take` | number | Max results (default: 50, max: 100) |
| `skip` | number | Offset for pagination (default: 0) |

**Response:** Array of meeting objects with `_count.actionItems` and `_count.keyDecisions`.

---

## Get Meeting Detail

**GET /api/meetings/:id**

Returns full meeting including transcript, summary, action items, and key decisions.

```bash
curl -s "$DELEGATE_URL/api/meetings/MEETING_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

**Response fields:**
- `id`, `title`, `source`, `platform`, `locationUrl`
- `date` — ISO 8601 datetime
- `duration` — string (e.g. `"45 minutes"`)
- `participants` — string array of attendee names/emails
- `rawTranscript` — full transcript text (may be null)
- `summary` — AI-generated or manual summary (may be null)
- `status` — `raw` | `processing` | `processed`
- `reviewStatus` — `null` | `pending` | `generating` | `ready`
- `actionItems` — array of `{ id, text, assignee, done }`
- `keyDecisions` — array of `{ id, text }`
- `workspaceId`, `projectId`

---

## Create Meeting

**POST /api/meetings**

Creates a new meeting record. Use this to log a meeting and optionally attach a raw transcript for later processing.

```bash
curl -s -X POST "$DELEGATE_URL/api/meetings" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Q2 Planning Session",
    "source": "manual",
    "platform": "google_meet",
    "date": "2026-04-01T14:00:00Z",
    "duration": "60 minutes",
    "participants": ["alice@example.com", "bob@example.com"],
    "rawTranscript": "Alice: Let us review the roadmap...",
    "workspaceId": "WORKSPACE_ID"
  }'
```

**Body fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Meeting title |
| `date` | yes | ISO 8601 datetime |
| `source` | no | `manual` (default), `google_meet`, `zoom`, `teams`, `otter_ai` |
| `platform` | no | Display platform name |
| `locationUrl` | no | Join URL or location |
| `duration` | no | Human-readable duration string |
| `participants` | no | Array of participant names/emails |
| `rawTranscript` | no | Raw transcript text |
| `summary` | no | Manual summary (skip AI processing if provided) |
| `status` | no | `raw` (default) |
| `workspaceId` | no | Associate with workspace |
| `projectId` | no | Associate with project |

**Response:** Created meeting object (HTTP 201).

---

## Update Meeting

**PUT /api/meetings/:id**

Partial update — only include fields you want to change.

```bash
# Update summary and status
curl -s -X PUT "$DELEGATE_URL/api/meetings/MEETING_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"summary": "We aligned on Q2 goals. Key output: 3 action items assigned.", "status": "processed"}'

# Add or update transcript
curl -s -X PUT "$DELEGATE_URL/api/meetings/MEETING_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rawTranscript": "Full corrected transcript here..."}'
```

---

## Process Transcript with AI

**POST /api/meetings/:id/process**

Runs Claude/GPT on the raw transcript. Extracts:
- A 2–3 paragraph **summary**
- **Action items** with optional assignees
- **Key decisions**

Requires `rawTranscript` to be set on the meeting. Sets `status` to `processing`, then `processed` on success.

```bash
curl -s -X POST "$DELEGATE_URL/api/meetings/MEETING_ID/process" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "message": "Meeting processed successfully",
  "meeting": {
    "id": "...",
    "summary": "...",
    "status": "processed",
    "actionItems": [{ "id": "...", "text": "...", "assignee": "Alice", "done": false }],
    "keyDecisions": [{ "id": "...", "text": "..." }]
  }
}
```

If there is no transcript, returns `{ "success": true, "message": "Meeting marked as processed (no transcript)" }`.

---

## Update Action Item

**PUT /api/meetings/:id/actions/:actionId**

Mark an action item done, reassign, or edit its text.

```bash
# Mark done
curl -s -X PUT "$DELEGATE_URL/api/meetings/MEETING_ID/actions/ACTION_ITEM_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"done": true}'

# Reassign
curl -s -X PUT "$DELEGATE_URL/api/meetings/MEETING_ID/actions/ACTION_ITEM_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assignee": "bob@example.com"}'

# Edit text
curl -s -X PUT "$DELEGATE_URL/api/meetings/MEETING_ID/actions/ACTION_ITEM_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Revised action item description", "done": false}'
```

**Body fields:** `done` (boolean), `assignee` (string), `text` (string) — all optional, partial update.

---

## Generate Review Items

**POST /api/meetings/:id/generate-review**

Triggers AI analysis that produces typed `MeetingReviewItem` records (tasks, notes, email drafts, decisions, follow-ups). Requires a transcript. Sets `reviewStatus` to `generating`, then `ready` on completion.

```bash
curl -s -X POST "$DELEGATE_URL/api/meetings/MEETING_ID/generate-review" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

**Response:** `{ "success": true, "count": 5 }`

**Error:** `400` if no transcript. `500` if AI fails (resets `reviewStatus` to null).

---

## List Review Items

**GET /api/meetings/:id/review-items**

Returns AI-generated review items for a meeting. Each item has a type and an approval status.

```bash
curl -s "$DELEGATE_URL/api/meetings/MEETING_ID/review-items" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

**Response:** Array of `MeetingReviewItem`:
- `id`, `meetingId`, `userId`
- `type` — `task` | `note` | `email_draft` | `decision` | `follow_up`
- `title`, `content` (may be null), `data` (JSON, may be null)
- `status` — `pending` | `approved` | `dismissed`
- `createdAt`, `updatedAt`

---

## Approve a Review Item

**POST /api/meetings/:id/review-items**

Approves a review item, which may create a downstream record (e.g., a Task for `type: task`).

```bash
curl -s -X POST "$DELEGATE_URL/api/meetings/MEETING_ID/review-items" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"itemId": "REVIEW_ITEM_ID"}'

# With inline edits before approving
curl -s -X POST "$DELEGATE_URL/api/meetings/MEETING_ID/review-items" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"itemId": "REVIEW_ITEM_ID", "edits": {"title": "Revised task title", "content": "Updated details"}}'
```

---

## Update or Dismiss a Review Item

**PATCH /api/meetings/:id/review-items**

Edit or dismiss without approving.

```bash
# Dismiss
curl -s -X PATCH "$DELEGATE_URL/api/meetings/MEETING_ID/review-items" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"itemId": "REVIEW_ITEM_ID", "status": "dismissed"}'

# Inline edit
curl -s -X PATCH "$DELEGATE_URL/api/meetings/MEETING_ID/review-items" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"itemId": "REVIEW_ITEM_ID", "title": "New title", "content": "New content"}'
```

---

## Delete Meeting

**DELETE /api/meetings/:id**

Permanently deletes the meeting and all associated action items, decisions, and review items (cascade).

```bash
curl -s -X DELETE "$DELEGATE_URL/api/meetings/MEETING_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

**Response:** `{ "success": true }`

---

## Common Workflow

```bash
# 1. Create meeting with transcript
MEETING=$(curl -s -X POST "$DELEGATE_URL/api/meetings" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Sprint Retro","date":"2026-04-01T10:00:00Z","rawTranscript":"..."}')
MEETING_ID=$(echo $MEETING | jq -r '.id')

# 2. Process transcript with AI
curl -s -X POST "$DELEGATE_URL/api/meetings/$MEETING_ID/process" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"

# 3. Get full details
curl -s "$DELEGATE_URL/api/meetings/$MEETING_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '{summary, actionItems, keyDecisions}'

# 4. Mark first action item done
ACTION_ID=$(curl -s "$DELEGATE_URL/api/meetings/$MEETING_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq -r '.actionItems[0].id')
curl -s -X PUT "$DELEGATE_URL/api/meetings/$MEETING_ID/actions/$ACTION_ID" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"done":true}'
```

---

## Notes

- **Status lifecycle:** `raw` → (process) → `processing` → `processed`
- **reviewStatus lifecycle:** `null` → (generate-review) → `generating` → `ready`
- All endpoints enforce ownership — you can only access meetings belonging to the authenticated user.
- Timestamps are ISO 8601 UTC.
- `participants` is a string array — free-form names or emails.
