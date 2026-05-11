#!/usr/bin/env bash
# Idempotent post-deploy provisioning. Run by the /webhook/deploy handler in
# group-api.ts after `git pull && npm ci && npm run build`, before the
# delegate-agent.service restart.
#
# Picks up infra changes that the bare git-pull + node-build flow can't:
#   1. New or changed systemd units in deploy/*.service          → symlink + reload + restart
#   2. systemd drop-ins under deploy/systemd/*.service.d/*.conf  → symlink + reload + restart owning unit
#   3. Caddy env vars listed in deploy/caddy/required-env.list   → sync from /opt/delegate-agent/.env → /etc/caddy/secrets.env → restart caddy if changed
#   4. Caddyfile changes                                         → copy, validate, reload
#   5. Docker compose stacks under deploy/*/docker-compose.yml   → up -d --build
#
# Idempotent: tracks content hashes in /var/lib/delegate-agent/hashes/
# so unchanged files don't trigger spurious restarts.
#
# Safe to run by hand:    bash /opt/delegate-agent/deploy/post-deploy.sh
# Safe to run on every push: only acts when content actually changed.

set -uo pipefail

# Don't `set -e` — we want to continue past per-stack docker compose failures
# so a broken token-dashboard container doesn't block delegate-agent updates.

REPO_DIR="${REPO_DIR:-/opt/delegate-agent}"
STATE_DIR="${STATE_DIR:-/var/lib/delegate-agent}"
HASH_DIR="$STATE_DIR/hashes"
LOG_PREFIX="[post-deploy]"

mkdir -p "$HASH_DIR"
cd "$REPO_DIR"

log()  { echo "$LOG_PREFIX $*"; }
warn() { echo "$LOG_PREFIX WARN $*" >&2; }

hash_file() {
  [ -f "$1" ] && sha256sum "$1" | awk '{print $1}' || echo ""
}

# ─── 1. systemd units ────────────────────────────────────────────────────────
units_changed=()
shopt -s nullglob
for unit_path in deploy/*.service; do
  unit_name=$(basename "$unit_path")
  abs_unit_path=$(readlink -f "$unit_path")
  target=/etc/systemd/system/$unit_name

  # Symlink if absent or pointing elsewhere
  if [ "$(readlink "$target" 2>/dev/null || true)" != "$abs_unit_path" ]; then
    ln -sf "$abs_unit_path" "$target"
    log "linked $unit_name → $abs_unit_path"
  fi

  new_hash=$(hash_file "$unit_path")
  marker="$HASH_DIR/unit-$unit_name"
  old_hash=$(cat "$marker" 2>/dev/null || true)
  if [ "$new_hash" != "$old_hash" ]; then
    units_changed+=("$unit_name")
    echo "$new_hash" > "$marker"
  fi
done
shopt -u nullglob

if [ ${#units_changed[@]} -gt 0 ]; then
  log "units changed: ${units_changed[*]}"
  systemctl daemon-reload
  for u in "${units_changed[@]}"; do
    # delegate-agent.service is restarted by the deploy webhook itself —
    # don't restart it here or the running deploy bash would be SIGTERM'd.
    if [ "$u" = "delegate-agent.service" ]; then
      log "skipping restart of $u (deploy webhook handles it)"
      continue
    fi
    systemctl enable "$u" 2>/dev/null || true
    if systemctl restart "$u"; then
      log "restarted $u"
    else
      warn "restart $u failed (continuing)"
    fi
  done
fi

# ─── 2. systemd drop-ins ─────────────────────────────────────────────────────
# Pattern: deploy/systemd/<unit-name>.service.d/<name>.conf
# Mirrored into /etc/systemd/system/<unit-name>.service.d/<name>.conf via symlink.
# When any drop-in for a unit changes, daemon-reload and restart that unit
# (skipping delegate-agent.service for the same reason as step 1).
dropins_changed_units=()
shopt -s nullglob
for dropin_dir in deploy/systemd/*.service.d; do
  unit_name=$(basename "$dropin_dir")  # e.g. caddy.service.d
  owning_unit=${unit_name%.d}          # e.g. caddy.service
  target_dir=/etc/systemd/system/$unit_name
  mkdir -p "$target_dir"

  for conf_path in "$dropin_dir"/*.conf; do
    conf_name=$(basename "$conf_path")
    abs_conf_path=$(readlink -f "$conf_path")
    target=$target_dir/$conf_name

    if [ "$(readlink "$target" 2>/dev/null || true)" != "$abs_conf_path" ]; then
      ln -sf "$abs_conf_path" "$target"
      log "linked drop-in $unit_name/$conf_name → $abs_conf_path"
    fi

    new_hash=$(hash_file "$conf_path")
    marker="$HASH_DIR/dropin-$unit_name-$conf_name"
    old_hash=$(cat "$marker" 2>/dev/null || true)
    if [ "$new_hash" != "$old_hash" ]; then
      dropins_changed_units+=("$owning_unit")
      echo "$new_hash" > "$marker"
    fi
  done
done
shopt -u nullglob

# De-dup and restart affected units
if [ ${#dropins_changed_units[@]} -gt 0 ]; then
  systemctl daemon-reload
  # shellcheck disable=SC2207
  uniq_units=($(printf '%s\n' "${dropins_changed_units[@]}" | sort -u))
  for u in "${uniq_units[@]}"; do
    if [ "$u" = "delegate-agent.service" ]; then
      log "skipping restart of $u (deploy webhook handles it)"
      continue
    fi
    if systemctl restart "$u"; then
      log "restarted $u (drop-in changed)"
    else
      warn "restart $u failed (continuing)"
    fi
  done
fi

# ─── 3. Caddy secrets.env sync ───────────────────────────────────────────────
# Caddy resolves {env.X} in Caddyfile from its OWN process env (not /opt/delegate-agent/.env).
# The caddy.service drop-in (step 2) loads /etc/caddy/secrets.env. This step rewrites
# that file from the canonical .env using deploy/caddy/required-env.list as the allowlist.
# Reload alone won't re-read EnvironmentFile content — we restart on change.
REQ_LIST=deploy/caddy/required-env.list
ENV_SRC=/opt/delegate-agent/.env
SECRETS_FILE=/etc/caddy/secrets.env

if [ -f "$REQ_LIST" ] && [ -f "$ENV_SRC" ]; then
  mkdir -p /etc/caddy
  tmp=$(mktemp)
  {
    echo "# AUTO-GENERATED by deploy/post-deploy.sh from $ENV_SRC"
    echo "# Allowlist: deploy/caddy/required-env.list"
    echo "# Do not edit by hand — changes will be overwritten on next deploy."
    while IFS= read -r raw_name; do
      name=$(echo "$raw_name" | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
      [ -z "$name" ] && continue
      # Match KEY=... (allow optional surrounding quotes); take the LAST occurrence.
      val=$(grep -E "^${name}=" "$ENV_SRC" | tail -n1 | cut -d= -f2- || true)
      # Strip surrounding double-quotes if present
      val=${val%\"}; val=${val#\"}
      if [ -z "$val" ]; then
        warn "required Caddy env $name missing from $ENV_SRC — Caddy {env.$name} will be empty"
        continue
      fi
      echo "$name=$val"
    done < "$REQ_LIST"
  } > "$tmp"

  new_hash=$(hash_file "$tmp")
  live_hash=$(hash_file "$SECRETS_FILE")
  if [ "$new_hash" != "$live_hash" ]; then
    install -m 0640 -o root -g caddy "$tmp" "$SECRETS_FILE" 2>/dev/null || \
      install -m 0644 "$tmp" "$SECRETS_FILE"
    log "rewrote $SECRETS_FILE ($(wc -l <"$SECRETS_FILE" | tr -d ' ') lines)"
    if systemctl restart caddy; then
      log "restarted caddy to pick up new EnvironmentFile"
    else
      warn "caddy restart failed after secrets.env change"
    fi
  fi
  rm -f "$tmp"
fi

# ─── 4. Caddyfile ────────────────────────────────────────────────────────────
if [ -f deploy/Caddyfile ]; then
  new_hash=$(hash_file deploy/Caddyfile)
  marker="$HASH_DIR/Caddyfile"
  old_hash=$(cat "$marker" 2>/dev/null || true)

  # Also detect drift between repo and live config (covers manual edits + first run)
  live_hash=$(hash_file /etc/caddy/Caddyfile)

  if [ "$new_hash" != "$old_hash" ] || [ "$new_hash" != "$live_hash" ]; then
    if command -v caddy >/dev/null 2>&1 && \
       ! caddy validate --config deploy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
      warn "deploy/Caddyfile failed validation — NOT reloading"
    else
      cp deploy/Caddyfile /etc/caddy/Caddyfile
      if systemctl reload caddy; then
        log "Caddyfile updated and caddy reloaded"
        echo "$new_hash" > "$marker"
      else
        warn "caddy reload failed"
      fi
    fi
  fi
fi

# ─── 5. Docker compose stacks ────────────────────────────────────────────────
shopt -s nullglob
for compose_path in deploy/*/docker-compose.yml; do
  dir=$(dirname "$compose_path")
  stack=$(basename "$dir")

  # Hash the compose file + Dockerfile (if present) to skip rebuilds when nothing changed
  combined_hash=$(
    {
      hash_file "$compose_path"
      hash_file "$dir/Dockerfile"
      # Hash anything else the build might consume
      find "$dir" -maxdepth 2 -type f \( -name '*.sh' -o -name '*.py' \) -print0 2>/dev/null | \
        xargs -0 sha256sum 2>/dev/null | sort
    } | sha256sum | awk '{print $1}'
  )
  marker="$HASH_DIR/stack-$stack"
  old_hash=$(cat "$marker" 2>/dev/null || true)

  if [ "$combined_hash" = "$old_hash" ]; then
    log "stack $stack unchanged — skipping"
    continue
  fi

  log "bringing up stack: $stack"
  if (cd "$dir" && docker compose up -d --build 2>&1 | tail -10); then
    echo "$combined_hash" > "$marker"
  else
    warn "stack $stack failed (continuing)"
  fi
done
shopt -u nullglob

log "done"
