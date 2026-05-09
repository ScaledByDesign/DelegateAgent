# Token Dashboard for DelegateAgent
#
# Reads JSONL transcripts produced by Claude Agent SDK inside agent containers
# (mounted from the host at ${DATA_DIR}/sessions/<group>/.claude/projects/)
# and serves a local web UI with per-prompt cost analytics, hotspot views,
# and per-group attribution.
#
# Upstream: https://github.com/nateherkai/token-dashboard (MIT)
#
# Build: docker build -t delegate-token-dashboard .
# Run:   see docker-compose.yml in this directory.

FROM python:3.12-slim

# Pin to a specific upstream commit so builds are reproducible.
# Bump this when you want to pull in upstream changes.
ARG TOKEN_DASHBOARD_REF=main

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --depth 1 --branch "${TOKEN_DASHBOARD_REF}" \
      https://github.com/nateherkai/token-dashboard.git . \
 && rm -rf .git

COPY symlink-projects.py /usr/local/bin/symlink-projects.py
COPY entrypoint.sh       /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/symlink-projects.py

# Read-only sessions volume mounts here.
RUN mkdir -p /data/sessions /aggregated-projects /cache

# Defaults (override via compose env). HOST=0.0.0.0 is intentional inside
# the container — exposure is gated by the compose port binding (127.0.0.1)
# and the Caddy reverse proxy with basic auth.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    CLAUDE_PROJECTS_DIR=/aggregated-projects \
    TOKEN_DASHBOARD_DB=/cache/token-dashboard.db \
    SYMLINK_REFRESH_SECONDS=30

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
