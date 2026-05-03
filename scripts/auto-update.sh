#!/bin/bash
# ─── DelegateAgent Auto-Update ───
# Checks for new commits on the main branch and rebuilds if changed.
# Run via cron: * * * * * root /opt/delegate-agent/scripts/auto-update.sh
# Or triggered via webhook/API.
#
# Safe: uses --ff-only so it never forces or creates merge commits.
# Idempotent: no-ops if HEAD hasn't changed.

set -euo pipefail

AGENT_DIR="${REMOTE_AGENT_DIR:-/opt/delegate-agent}"
LOG_PREFIX="[delegate-agent-update]"

cd "$AGENT_DIR"

# MERGE_LOCK gate: skip auto-pulls during release-branch big-merges.
# Engineer commits MERGE_LOCK to release branch; droplets skip pulls.
# Engineer removes MERGE_LOCK in final merge commit. CI guards main.
if [ -f "$AGENT_DIR/MERGE_LOCK" ]; then
  echo "$LOG_PREFIX MERGE_LOCK present at $AGENT_DIR/MERGE_LOCK — skipping pull"
  exit 0
fi

# Record current HEAD
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "none")

# Fast-forward pull (never creates merge commits). Stderr surfaces in journalctl.
git pull origin main --ff-only || {
  echo "$LOG_PREFIX git pull failed — skipping cycle (see preceding stderr)"
  exit 0
}

AFTER=$(git rev-parse HEAD 2>/dev/null || echo "none")

# No changes
if [ "$BEFORE" = "$AFTER" ]; then
  exit 0
fi

echo "$LOG_PREFIX Updating from ${BEFORE:0:8} to ${AFTER:0:8}"

# Reinstall deps if package-lock changed
if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package-lock.json"; then
  echo "$LOG_PREFIX package-lock.json changed — running npm ci"
  npm ci --no-fund --no-audit 2>&1 | tail -5
fi

# Rebuild TypeScript
echo "$LOG_PREFIX Rebuilding..."
npm run build 2>&1 | tail -5

# Run delegate patch (ensures container env, TOS, settings are up to date)
if [ -f "$AGENT_DIR/delegate-patch.mjs" ]; then
  node "$AGENT_DIR/delegate-patch.mjs" 2>&1 | tail -3
fi

# Sync Caddyfile if it changed in the diff (so /admin* + /api/* routing changes apply automatically)
if git diff --name-only "$BEFORE" "$AFTER" | grep -q "^deploy/Caddyfile$"; then
  echo "$LOG_PREFIX deploy/Caddyfile changed — syncing to /etc/caddy/Caddyfile + reloading"
  if [ -f "$AGENT_DIR/deploy/Caddyfile" ] && [ -d /etc/caddy ]; then
    cp "$AGENT_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
    systemctl reload caddy 2>&1 | tail -3 || echo "$LOG_PREFIX caddy reload failed (non-fatal)"
  fi
fi

# Restart the service
echo "$LOG_PREFIX Restarting service..."
systemctl restart delegate-agent 2>/dev/null || systemctl restart remote-agent 2>/dev/null || true

echo "$LOG_PREFIX Update complete: ${BEFORE:0:8} → ${AFTER:0:8}"
date
