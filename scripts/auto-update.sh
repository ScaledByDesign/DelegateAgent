#!/bin/bash
# ─── DelegateAgent Auto-Update ───
# Canonical deploy path. Triggered by:
#   1. cron every minute — catches missed webhook events + auto-heals stale dist.
#   2. `systemctl start delegate-agent-update.service` — invoked by the
#      in-process deploy webhook in src/group-api.ts. Type=oneshot serializes
#      concurrent invocations, so cron + webhook are safe to overlap.
#
# Idempotent: no-ops when HEAD hasn't changed AND `dist/` is fresh relative
# to HEAD. The "dist freshness" check is the auto-heal seam — if a prior
# build failed silently (the in-process webhook used to fork with
# stdio:'ignore'), the next cron tick rebuilds without needing a new commit.

set -euo pipefail

AGENT_DIR="${REMOTE_AGENT_DIR:-/opt/delegate-agent}"
LOG_PREFIX="[delegate-agent-update]"
# Marker file for drift detection. Any compiled artifact works; we pick one
# that's small + always present so the mtime reflects the most recent build.
DIST_MARKER="$AGENT_DIR/dist/chat/event-emitter.js"

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

# ── Auto-heal drift check ────────────────────────────────────────────────
# If HEAD's commit timestamp is newer than `dist/`'s mtime by >60s, the
# previous build silently failed and the running binary is stale. Rebuild
# even when BEFORE == AFTER so cron self-heals within one tick.
HEAD_TS=$(git log -1 --format=%ct 2>/dev/null || echo 0)
DIST_TS=$(stat -c %Y "$DIST_MARKER" 2>/dev/null || echo 0)
DIST_STALE=no
if [ "$HEAD_TS" -gt "$((DIST_TS + 60))" ]; then
  DIST_STALE=yes
fi

# Nothing to do — HEAD unchanged AND dist is fresh.
if [ "$BEFORE" = "$AFTER" ] && [ "$DIST_STALE" = "no" ]; then
  exit 0
fi

if [ "$DIST_STALE" = "yes" ] && [ "$BEFORE" = "$AFTER" ]; then
  echo "$LOG_PREFIX dist stale (HEAD commit_ts=$HEAD_TS > dist_mtime=$DIST_TS + 60s) — rebuilding without new commit"
else
  echo "$LOG_PREFIX Updating from ${BEFORE:0:8} to ${AFTER:0:8}"
fi

# Reinstall deps if package-lock changed OR if we're recovering from drift
# (the failed prior build may have been an `npm ci` failure).
LOCK_CHANGED=no
if [ "$BEFORE" != "$AFTER" ] && \
   git diff --name-only "$BEFORE" "$AFTER" | grep -q "^package-lock.json$"; then
  LOCK_CHANGED=yes
fi
if [ "$LOCK_CHANGED" = "yes" ] || [ "$DIST_STALE" = "yes" ]; then
  # NODE_ENV=development keeps devDeps (tsc lives there) — `npm ci` honors
  # NODE_ENV=production by stripping devDeps, which silently breaks the build.
  # --ignore-scripts skips the `prepare: husky` hook that fails without a
  # git-hooks worktree, and ALSO skips better-sqlite3's native-binding install
  # script — so we rebuild it explicitly next.
  echo "$LOG_PREFIX npm ci (NODE_ENV=development, --ignore-scripts)"
  NODE_ENV=development npm ci --ignore-scripts --no-fund --no-audit 2>&1 | tail -3
  echo "$LOG_PREFIX npm rebuild better-sqlite3 (native binding)"
  npm rebuild better-sqlite3 2>&1 | tail -3
fi

# Rebuild TypeScript. NODE_ENV=development so devDeps (tsc) resolve in case
# this script runs under the agent service env (NODE_ENV=production).
echo "$LOG_PREFIX Rebuilding..."
NODE_ENV=development npm run build 2>&1 | tail -5

# Verify the build actually advanced dist before restarting the live service.
# If dist is still stale, something failed silently — don't tear down a working
# old process for a non-starting new one.
NEW_DIST_TS=$(stat -c %Y "$DIST_MARKER" 2>/dev/null || echo 0)
if [ "$HEAD_TS" -gt "$((NEW_DIST_TS + 60))" ]; then
  echo "$LOG_PREFIX BUILD FAILED — dist still stale (HEAD commit_ts=$HEAD_TS > dist_mtime=$NEW_DIST_TS). Aborting restart so the running old binary keeps serving."
  exit 1
fi

# Run delegate patch (ensures container env, TOS, settings are up to date)
if [ -f "$AGENT_DIR/delegate-patch.mjs" ]; then
  node "$AGENT_DIR/delegate-patch.mjs" 2>&1 | tail -3
fi

# Run post-deploy.sh — infra changes (systemd units, Caddyfile content-hash
# sync, docker-compose stacks under deploy/*/). Idempotent + tracks hashes
# so unchanged files don't trigger spurious restarts. Absent on older
# checkouts mid-roll, so non-fatal if missing.
if [ -x "$AGENT_DIR/deploy/post-deploy.sh" ]; then
  echo "$LOG_PREFIX Running post-deploy.sh"
  bash "$AGENT_DIR/deploy/post-deploy.sh" 2>&1 | tail -30
fi

# Caddyfile fast-path sync (back-compat — post-deploy.sh handles the
# canonical case via content hashes, but pre-post-deploy droplets still
# need this seam to apply routing changes).
if [ "$BEFORE" != "$AFTER" ] && \
   git diff --name-only "$BEFORE" "$AFTER" | grep -q "^deploy/Caddyfile$"; then
  if [ -f "$AGENT_DIR/deploy/Caddyfile" ] && [ -d /etc/caddy ]; then
    echo "$LOG_PREFIX deploy/Caddyfile changed — syncing to /etc/caddy/Caddyfile + reloading"
    cp "$AGENT_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
    systemctl reload caddy 2>&1 | tail -3 || echo "$LOG_PREFIX caddy reload failed (non-fatal)"
  fi
fi

# Restart the service
echo "$LOG_PREFIX Restarting service..."
systemctl restart delegate-agent 2>/dev/null || systemctl restart remote-agent 2>/dev/null || true

echo "$LOG_PREFIX Update complete: ${BEFORE:0:8} → ${AFTER:0:8} (dist_mtime=$NEW_DIST_TS)"
date
