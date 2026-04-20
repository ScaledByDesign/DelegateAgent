# DelegateAgent

> DelegateAgent for use in the Delegate workspace platform. Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) — upstream-sync map at `docs/UPSTREAM-SYNC.md`.

## What's Different

This fork adds Delegate-specific customizations as first-class committed code:

| Component | Description |
|-----------|-------------|
| `src/channels/delegate.ts` | Delegate channel integration (polling + webhook) |
| `src/group-api.ts` | HTTP API for group registration + context push |
| `.claude/skills/delegate-*` | 38 Delegate-specific agent skills |
| `scripts/auto-update.sh` | Git-based auto-update for droplet deployments |

## Deployment

DelegateAgent droplets are provisioned via Delegate's cloud-init system:

```typescript
// In Delegate's deployment config:
generateDelegateAgentCloudInit({
  repoUrl: "https://github.com/ScaledByDesign/delegate-agent.git",
  // ... other config
});
```

The droplet will:
1. Clone this repo to `/opt/delegate-agent`
2. Build and start the service
3. Install a 60-second cron job for auto-updates

## Auto-Update

Once deployed, `scripts/auto-update.sh` runs every minute:
- `git pull --ff-only` (safe, never merges)
- Rebuilds only when HEAD changes
- Only runs `npm ci` when `package-lock.json` changes
- Restarts the service after rebuild

**To deploy changes: just `git push` to `main`.**

## Group + Context API

The HTTP API on port 3001 provides:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/groups` | GET | List registered groups |
| `/api/groups` | POST | Register a new agent group |
| `/api/context/:folder` | POST | Push CLAUDE.md to group folder |
| `/api/health` | GET | Git SHA + uptime |

All endpoints require `Authorization: Bearer <token>` using either `DELEGATE_API_KEY` or `DELEGATE_AGENT_TOKEN` (or the legacy `NANOCLAW_TOKEN` for one release).

## Development

```bash
npm ci
npm run build
npm start
```

## License

Private — ScaledByDesign internal use only.

## Upstream

Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) — upstream-sync map at `docs/UPSTREAM-SYNC.md`.
