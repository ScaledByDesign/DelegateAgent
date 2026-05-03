# DelegateAgent Logging

## Environment Variables

| Variable | Values | Default | Effect |
|----------|--------|---------|--------|
| `LOG_FORMAT` | `json` \| `pretty` | `pretty` | `json` emits newline-delimited JSON; `pretty` uses colored human-readable output |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `fatal` | `info` | Minimum level to emit |
| `SENTRY_DSN` | DSN URL | (none) | Required for Sentry to initialize in production |
| `SENTRY_DISABLED` | `1` \| `true` | (unset) | Set to opt out of Sentry even when `NODE_ENV=production` and `SENTRY_DSN` is set |

## JSON Log Schema (`LOG_FORMAT=json`)

Every log line is a single newline-terminated JSON object:

```json
{
  "ts":      "2026-05-02T14:23:01.456Z",  // ISO 8601, always present
  "level":   "info",                       // debug|info|warn|error|fatal, always present
  "msg":     "State loaded",               // human message, always present
  "context": {                             // optional, present when extra fields are logged
    "groupFolder": "main",
    "taskId":      "abc123",
    "chatJid":     "12345@g.us",
    "containerName": "da-abc",
    "err": { "type": "Error", "message": "...", "stack": "..." }
  }
}
```

Errors under the `err` key are serialized to `{ type, message, stack }` — not raw Error objects.

## Sentry Activation

Sentry initializes automatically when **all** of the following are true:

1. `NODE_ENV === "production"`
2. `SENTRY_DSN` is non-empty
3. `SENTRY_DISABLED` is not set to `1` or `true`

To opt out on a specific droplet: `echo 'SENTRY_DISABLED=1' >> /opt/remote-agent/.env`

## Live Log Tailing (Production)

```bash
# Stream JSON logs via journalctl + jq (requires LOG_FORMAT=json in the service unit):
journalctl -u delegate-agent -o cat -f | jq -c

# Filter for errors only:
journalctl -u delegate-agent -o cat -f | jq -c 'select(.level == "error" or .level == "fatal")'

# Extract token usage (future Phase 2 gate):
journalctl -u delegate-agent -o cat --since="7 days ago" \
  | jq -r 'select(.context.tokens_used) | .context.tokens_used'
```
