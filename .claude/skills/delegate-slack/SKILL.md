---
name: delegate-slack
description: Send messages, list channels, and read threads via Slack integration
---

# Delegate Slack Integration

Send messages to Slack, list channels, and read thread replies — all proxied through the Delegate agent integration layer. Credentials stay server-side; the agent never handles Slack tokens directly.

**Requires:** The workspace must have an active Slack integration configured in Settings → Integrations.

All calls require:
```
-H "Authorization: Bearer $DELEGATE_API_TOKEN"
-H "Content-Type: application/json"
```

Endpoint pattern:
```
POST $DELEGATE_URL/api/agent/integrations/slack/<action>
```

Pass `taskId` or `workspaceId` in the body so the proxy can resolve which workspace's Slack credentials to use.

---

## Send Message

**POST /api/agent/integrations/slack/send-message**

Posts a message to a channel or thread.

```bash
# Post to a channel
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/send-message" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "channel": "#general",
    "text": "Task completed: updated the deployment pipeline."
  }'

# Reply to a thread
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/send-message" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "channel": "C0123456789",
    "text": "Done — PR is up for review.",
    "thread_ts": "1712000000.000100"
  }'

# Post with Block Kit blocks (rich formatting)
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/send-message" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "channel": "#engineering",
    "text": "Deployment complete",
    "blocks": [
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": "*Deployment complete* :rocket:\nAll services healthy." }
      }
    ]
  }'
```

**Body fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `taskId` | yes* | Task ID to resolve workspace context |
| `workspaceId` | yes* | Alternative to `taskId` — direct workspace ID |
| `channel` | yes | Channel name (`#general`) or Slack channel ID (`C0123456789`) |
| `text` | yes** | Message text (Slack mrkdwn supported) |
| `thread_ts` | no | Timestamp of parent message to reply in-thread |
| `blocks` | no | Block Kit blocks array for rich formatting |

*Either `taskId` or `workspaceId` must be provided.
**Either `text` or `blocks` must be provided (both is fine).

**Response:** Slack API `chat.postMessage` response — includes `ts` (message timestamp), `channel`, `message`.

---

## List Channels

**POST /api/agent/integrations/slack/list-channels**

Lists channels the bot has access to.

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/list-channels" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "TASK_ID"}'

# Limit results
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/list-channels" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "TASK_ID", "limit": 50}'

# Filter to public channels only
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/list-channels" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": "TASK_ID", "types": "public_channel"}'
```

**Body fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `taskId` | yes* | Task ID to resolve workspace |
| `workspaceId` | yes* | Alternative to `taskId` |
| `types` | no | Comma-separated channel types (default: `public_channel,private_channel`) |
| `limit` | no | Max channels to return (default: 100) |

**Response:** Slack API `conversations.list` response — `channels` array with `id`, `name`, `is_private`, `num_members`, etc.

```bash
# Extract channel names and IDs
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/list-channels" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"TASK_ID"}' | jq '.channels[] | {id, name}'
```

---

## Get Thread

**POST /api/agent/integrations/slack/get-thread**

Fetches all replies in a message thread.

```bash
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/get-thread" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "channel": "C0123456789",
    "ts": "1712000000.000100"
  }'

# Limit to last 20 messages
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/get-thread" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK_ID",
    "channel": "C0123456789",
    "ts": "1712000000.000100",
    "limit": 20
  }'
```

**Body fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `taskId` | yes* | Task ID to resolve workspace |
| `workspaceId` | yes* | Alternative to `taskId` |
| `channel` | yes | Slack channel ID (not name — use `list-channels` to get IDs) |
| `ts` | yes | Timestamp of the parent message (from `send-message` response or `list-messages`) |
| `limit` | no | Max replies to return (default: 50) |

**Response:** Slack API `conversations.replies` response — `messages` array, each with `user`, `text`, `ts`, `blocks`.

---

## Common Workflow

```bash
# 1. Find the right channel
CHANNELS=$(curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/list-channels" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"TASK_ID"}')
echo $CHANNELS | jq '.channels[] | select(.name | contains("engineering")) | {id, name}'

# 2. Post a status update
RESULT=$(curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/send-message" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"TASK_ID","channel":"C0123456789","text":"Analysis complete. Results attached."}')
TS=$(echo $RESULT | jq -r '.ts')

# 3. Reply in thread with details
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/slack/send-message" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"taskId\":\"TASK_ID\",\"channel\":\"C0123456789\",\"thread_ts\":\"$TS\",\"text\":\"Details: found 3 issues, all resolved.\"}"
```

---

## Error Handling

| Status | Meaning | Fix |
|--------|---------|-----|
| `401 Unauthorized` | Invalid `$DELEGATE_API_TOKEN` | Check token env var |
| `404 Not Found` | No active Slack integration | User must connect Slack in Settings → Integrations |
| `400 Bad Request` | Missing required field | Check `channel`, `text`, `ts` |
| `502 Bad Gateway` | Slack API rejected the call | Check Slack error in response body (e.g., `channel_not_found`, `not_in_channel`) |

**Common Slack errors:**
- `channel_not_found` — Channel ID is wrong; use `list-channels` to verify
- `not_in_channel` — Bot is not a member of the channel; invite it in Slack
- `invalid_auth` — Slack bot token expired; re-connect Slack in workspace settings

---

## Notes

- **Action names use hyphens** — `send-message`, `list-channels`, `get-thread` (not underscores).
- **Channel parameter** — The `send-message` action accepts both `#channel-name` and `C0123456789` IDs. The `get-thread` action requires the channel **ID**, not the name.
- **Thread timestamps** — Slack `ts` values look like `"1712000000.000100"`. Always pass them as strings.
- **Credentials are workspace-scoped** — The bot token belongs to the workspace that connected Slack. Agents operating across workspaces must pass the correct `workspaceId`.
- **Rate limits** — Slack tier-1 methods allow ~1 req/s. Avoid polling in tight loops.
