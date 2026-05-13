#!/usr/bin/env bash
# Restore messages.db from the latest backup taken by deploy/post-deploy.sh.
#
# Usage (on the droplet):
#   sudo bash /opt/delegate-agent/scripts/restore-messages-db.sh
#   sudo bash /opt/delegate-agent/scripts/restore-messages-db.sh /path/to/specific.bak
#
# Stops the delegate-agent service, restores the file, and restarts. If the
# specified backup file is missing or unreadable, exits non-zero and leaves
# the service in its current state.
#
# Reference: droplet_better_sqlite3_sigbus.md (2026-05-04 incident playbook);
# matches the backup hook in deploy/post-deploy.sh (Phase 1.5 of Archon port).

set -uo pipefail

REPO_DIR="${REPO_DIR:-/opt/delegate-agent}"
STATE_DIR="${STATE_DIR:-/var/lib/delegate-agent}"
MESSAGES_DB="${MESSAGES_DB:-$REPO_DIR/messages.db}"
BACKUP_DIR="${BACKUP_DIR:-$STATE_DIR/db-backups}"

usage() {
  echo "Usage: $0 [backup_file]"
  echo "  Without arg: restores from the most recent backup in $BACKUP_DIR/"
  echo "  With arg:    restores from the specified backup path"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

# Pick backup file
if [ -n "${1:-}" ]; then
  BACKUP_FILE="$1"
else
  BACKUP_FILE=$(ls -1t "$BACKUP_DIR"/messages.db.bak-* 2>/dev/null | head -n 1 || true)
fi

if [ -z "$BACKUP_FILE" ] || [ ! -r "$BACKUP_FILE" ]; then
  echo "ERROR: no readable backup found"
  echo "  searched: $BACKUP_DIR/messages.db.bak-*"
  echo "  hint: ls $BACKUP_DIR/"
  exit 1
fi

echo "Restoring messages.db from: $BACKUP_FILE ($(stat -c %s "$BACKUP_FILE" 2>/dev/null || echo "?") bytes)"
echo "Target: $MESSAGES_DB"
echo "Press Ctrl-C within 5 seconds to abort..."
sleep 5

# Stop service (try both unit names, like auto-update.sh does)
echo "Stopping delegate-agent service..."
systemctl stop delegate-agent 2>/dev/null || systemctl stop remote-agent 2>/dev/null || {
  echo "WARNING: could not stop service via systemctl — restore may race with running agent"
}

# Save the pre-restore DB as a safety snapshot so a botched restore is reversible.
if [ -f "$MESSAGES_DB" ]; then
  PRE_RESTORE="$MESSAGES_DB.pre-restore-$(date +%s)"
  cp -p "$MESSAGES_DB" "$PRE_RESTORE"
  echo "Saved current DB → $PRE_RESTORE"
fi

# Copy backup into place.
cp -p "$BACKUP_FILE" "$MESSAGES_DB"
echo "Restored $MESSAGES_DB"

# Restart service.
echo "Starting delegate-agent service..."
systemctl start delegate-agent 2>/dev/null || systemctl start remote-agent 2>/dev/null || {
  echo "ERROR: could not start service via systemctl"
  exit 2
}

echo "Restore complete. Recent journal entries:"
journalctl -u delegate-agent --since="1 minute ago" --no-pager 2>/dev/null | tail -20 || true
