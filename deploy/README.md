# DelegateAgent + Bifrost Deployment Guide

## Architecture

```
┌─────────────────────────────────────────────────┐
│  DigitalOcean Droplet (159.89.226.182)          │
│                                                  │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ DelegateAgent│  │ Bifrost  │  │ Caddy (TLS)  │  │
│  │ :3001        │  │ :4000    │  │ :443         │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │              │               │          │
│       │  localhost    │  localhost    │  HTTPS   │
│       └──────────────┘               │          │
│                                      │          │
└──────────────────────────────────────┼──────────┘
                                       │
                          ┌────────────┘
                          │
              ┌───────────┴──────────┐
              │ delegate.ws (Vercel) │
              │ /api/agent/channel/* │
              │ /api/webhooks/sentry │
              │ /api/webhooks/github │
              │ /api/inngest         │
              └──────────────────────┘
```

## Prerequisites

- DigitalOcean droplet (s-2vcpu-4gb minimum)
- Docker installed
- Node.js 20+
- Domain DNS: `agent.delegate.ws` + `gateway.delegate.ws` → droplet IP

## Quick Setup

```bash
# 1. Clone the repo
git clone https://github.com/ScaledByDesign/delegate-agent.git /opt/delegate-agent
cd /opt/delegate-agent

# 2. Install dependencies
npm ci

# 3. Configure environment
cp deploy/env.example .env
# Edit .env with real values (see below)

# 4. Build
npm run build

# 5. Install systemd services
cp deploy/delegate-agent.service /etc/systemd/system/
cp deploy/bifrost.service /etc/systemd/system/
systemctl daemon-reload

# 6. Install Caddy and configure
cp deploy/Caddyfile /etc/caddy/Caddyfile
# Replace <BCRYPT_HASH> with: caddy hash-password --plaintext "YourPassword"
systemctl reload caddy

# 7. Install Bifrost
npm install -g @maximhq/bifrost
mkdir -p /opt/bifrost
# Generate config from template:
envsubst < deploy/bifrost-config.template.json > /opt/bifrost/config.json

# 8. Start services
systemctl start bifrost
systemctl start delegate-agent
systemctl enable bifrost delegate-agent

# 9. Verify
curl -s http://localhost:4000/health   # Bifrost
curl -s https://agent.delegate.ws/health  # DelegateAgent via Caddy
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Bifrost virtual key (`sk-bf-*`) for LLM routing | `sk-bf-10d6aab3-...` |
| `ANTHROPIC_BASE_URL` | Bifrost Anthropic proxy | `http://localhost:4000/anthropic` |
| `OPENAI_API_KEY` | OpenAI key (for Bifrost provider) | `sk-proj-...` |
| `DELEGATE_URL` | Delegate app URL | `https://delegate.ws` |
| `DELEGATE_API_KEY` | Token for channel auth (matches Vercel `DELEGATE_AGENT_TOKEN`) | `0ab6b3d9...` |
| `DELEGATE_AGENT_TOKEN` | Same as DELEGATE_API_KEY (legacy: `NANOCLAW_TOKEN` still accepted for one release) | `0ab6b3d9...` |
| `GITHUB_TOKEN` | Admin fallback only — workspace tokens resolved from Delegate DB | `ghp_...` |
| `BIFROST_URL` | Bifrost health check endpoint | `http://localhost:4000` |

### GitHub Token Note

Task-scoped git operations (Sentry auto-fix, PR creation) use **per-workspace tokens** resolved from the Delegate `WorkspaceIntegration` table via `lib/integrations/github-token.ts`. The `GITHUB_TOKEN` env var is an admin-only fallback — it is NOT used for user-facing operations in production.

## Delegate Platform Setup

On the Delegate side (Vercel):

### 1. Vercel Environment Variables
```
DELEGATE_AGENT_TOKEN=<same as DELEGATE_API_KEY on droplet>
INNGEST_BASE_URL=https://inngest.delegate.ws
INNGEST_EVENT_KEY=<from Inngest server>
INNGEST_SIGNING_KEY=signkey-prod-<from Inngest server>
USE_INNGEST_PIPELINE=true  # or set in PlatformSetting DB
INNGEST_DEV=1  # temporary: skip signing verification
```

### 2. Database Setup (PlatformSettings)
Enable the Inngest pipeline via the Super Admin System panel:
- `use_inngest_pipeline` → `true`

### 3. Sentry Integration
1. Connect Sentry in WebOS → Integrations → Sentry
2. Enable auto-fix: the pipeline config is stored in `WorkspaceIntegration.publicMeta.autoFixConfig`
3. Configure: `enabled: true`, `requireProjectMapping: false`, `minEventCount: 1`

### 4. GitHub Integration
1. Connect GitHub in WebOS → Integrations → GitHub (OAuth)
2. Link project: Create a `ProjectConnection` (type: github) with `repoOwner` + `repoName`
3. Webhook auto-registration happens on OAuth connect

### 5. Agent Profile
Ensure an active `AgentProfile` exists with `adapterType: delegate_agent` for the workspace owner.

## Sentry → GitHub Pipeline Flow

```
1. Sentry alert fires webhook → /api/webhooks/sentry
2. Webhook emits Inngest event: sentry/alert.triggered
3. Inngest function: create-task → auto-delegate → wait-for-pr → auto-review
4. DelegateAgent polls /api/agent/channel/poll → picks up agent message
5. Container spawns → Claude Code fixes the bug → opens PR
6. Reply endpoint detects PR URL → advances stage to pr_opened
7. GitHub webhook (or Inngest event) triggers auto-review
8. Review passes → PR merged → Sentry issue resolved → stage: done
```

## Monitoring

- **Inngest Dashboard**: https://inngest.delegate.ws (basic auth)
- **WebOS Sentry Pipeline app**: Kanban board showing all pipeline stages
- **DelegateAgent logs**: `journalctl -u delegate-agent -f`
- **Bifrost logs**: `journalctl -u bifrost -f`

## Polling Intervals

| Component | Interval | Purpose |
|-----------|----------|---------|
| DelegateAgent → Delegate poll | 15s | Check for new agent messages |
| Inngest cron functions | 1-5m | Background jobs |
| Sentry pipeline timeout | 2h | Max wait for PR creation |
| Agent message pipeline | 5m | Max wait for agent reply |
| Bifrost health check | 60s | Monitor LLM gateway |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "throttled: true" on poll | Verify MAX_CONCURRENT_POLLS removed from poll endpoint |
| Bifrost health fails | Check `BIFROST_URL=http://localhost:4000` in .env |
| Agent doesn't pick up messages | Check registered groups: `sqlite3 store/messages.db 'SELECT jid FROM registered_groups'` |
| Container doesn't spawn | Check Docker: `docker ps -a`, check image: `docker images delegate-agent` |
| Pipeline stuck at "delegated" | Agent reply must flow through `/api/agent/channel/reply` to advance stages |
