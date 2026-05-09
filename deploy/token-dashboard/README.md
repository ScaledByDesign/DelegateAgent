# Token Dashboard

Local cost analytics for DelegateAgent's agent containers. Reads the JSONL
transcripts Claude Agent SDK writes inside each container (mounted to the
host at `${DATA_DIR}/sessions/<group>/.claude/projects/`) and serves a
dashboard with per-prompt cost, tool/file heatmaps, session breakdowns, and
**per-group attribution** (each WhatsApp / Telegram / Slack chat shows up
as its own row).

Vendored from upstream: <https://github.com/nateherkai/token-dashboard> (MIT).

## How it fits

- DelegateAgent itself runs as a host systemd service. Token Dashboard runs
  as a Docker container alongside it.
- Read-only bind mount of `${DATA_DIR}/sessions` → `/data/sessions`.
- A small Python flattener (`symlink-projects.py`) symlinks each
  `<group>/.claude/projects/<slug>` to `/aggregated-projects/<group>__<slug>`,
  giving token-dashboard's scanner the flat layout it expects while
  preserving the group identity in the project label.
- Caddy fronts at `https://tokens.delegate.ws` with basic auth.

```
host:  ${DATA_DIR}/sessions/<group>/.claude/projects/<slug>/<sid>.jsonl
   │
   │ bind-mount :ro
   ▼
container:  /data/sessions/<group>/.claude/projects/<slug>/<sid>.jsonl
   │
   │ symlink-projects.py (every 30s)
   ▼
container:  /aggregated-projects/<group>__<slug>  →  /data/sessions/<group>/.claude/projects/<slug>
   │
   │ token-dashboard scanner (CLAUDE_PROJECTS_DIR=/aggregated-projects)
   ▼
SQLite cache at /cache/token-dashboard.db
```

## Local dev

```bash
DATA_DIR=$(pwd)/../../data docker compose up --build
open http://127.0.0.1:8082
```

## Production (DigitalOcean droplet)

```bash
# One-time install
ssh root@159.89.226.182
ln -sf /opt/delegate-agent/deploy/token-dashboard.service \
       /etc/systemd/system/token-dashboard.service
systemctl daemon-reload
systemctl enable --now token-dashboard.service

# Add DNS A record: tokens.delegate.ws → 159.89.226.182
# Reload Caddy to pick up the new vhost
systemctl reload caddy
```

Now reachable at <https://tokens.delegate.ws> (basic auth: `admin` /
realm password — same as `agent.delegate.ws`). Update creds with
`caddy hash-password --plaintext "newpw"`.

## Bumping the upstream

Edit the `TOKEN_DASHBOARD_REF` arg in `Dockerfile` and `docker-compose.yml`
to a tag or commit SHA, then `docker compose build --no-cache && docker
compose up -d`.

## Operational notes

- **Read-only**: the sessions mount is `:ro`. token-dashboard never writes
  to JSONL files; its SQLite cache lives on a separate named volume.
- **Single instance**: upstream warns that running two dashboards against
  the same SQLite DB causes contention. The systemd unit ensures one.
- **Cache reset**: `docker compose down && docker volume rm
  token-dashboard_token-dashboard-cache && docker compose up -d` rebuilds
  the SQLite cache from scratch.
- **What it shows**: token usage *inside* agent containers (where the cost
  lives). Does NOT show DelegateAgent's own Node process tokens (channel
  routing, IPC orchestration) — those are negligible by comparison.
- **Per-group attribution**: each project row's name is `<group>__<slug>`,
  so sorting the Projects tab by tokens gives you the most expensive
  channels at a glance.
- **Privacy**: nothing leaves the droplet. Upstream is stdlib-only Python,
  no external API calls for your data, fonts/JS served locally.
