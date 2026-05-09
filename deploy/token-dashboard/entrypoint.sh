#!/usr/bin/env bash
# Entrypoint for the DelegateAgent token-dashboard container.
#
# 1. Runs the symlink flattener once up-front so the dashboard sees data
#    on its first scan.
# 2. Loops the flattener every $SYMLINK_REFRESH_SECONDS in the background
#    so newly-spawned groups appear without restarting the container.
# 3. Starts token-dashboard headless (--no-open).

set -euo pipefail

REFRESH="${SYMLINK_REFRESH_SECONDS:-30}"

echo "[entrypoint] sessions dir: ${SESSIONS_DIR:-/data/sessions}"
echo "[entrypoint] aggregated dir: ${AGGREGATED_DIR:-/aggregated-projects}"
echo "[entrypoint] db: ${TOKEN_DASHBOARD_DB}"
echo "[entrypoint] refresh interval: ${REFRESH}s"

# Initial sync — fail loudly if the mount isn't where we expect it.
python3 /usr/local/bin/symlink-projects.py

(
  while sleep "$REFRESH"; do
    python3 /usr/local/bin/symlink-projects.py || \
      echo "[entrypoint] symlink refresh failed (continuing)"
  done
) &

exec python3 cli.py dashboard --no-open
