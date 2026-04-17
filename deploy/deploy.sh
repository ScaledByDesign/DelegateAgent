#!/bin/bash
set -euo pipefail

# ─── NanoClaw Agent — One-Command Deploy ──────────────────────────────────────
#
# Usage:
#   ./deploy/deploy.sh                    # Full deploy (build + push + restart)
#   ./deploy/deploy.sh --push-only        # Push code + restart (skip build)
#   ./deploy/deploy.sh --container-only   # Rebuild container image only
#
# Prerequisites:
#   - SSH access to droplet (root@$DROPLET_IP)
#   - Docker installed on droplet
#   - /opt/nanoclaw/.env populated on droplet (see deploy/env.example)
#
# First-time setup: run ./deploy/deploy.sh --init
# ──────────────────────────────────────────────────────────────────────────────

DROPLET_IP="${DELEGATE_AGENT_IP:-159.89.226.182}"
SSH_USER="root"
REMOTE_DIR="/opt/nanoclaw"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err() { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ─── Connectivity check ──────────────────────────────────────────────────────

check_ssh() {
  log "Checking SSH connectivity to ${DROPLET_IP}..."
  if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_USER@$DROPLET_IP" "echo ok" >/dev/null 2>&1; then
    err "Cannot SSH to ${SSH_USER}@${DROPLET_IP}. Check your SSH keys."
    exit 1
  fi
}

# ─── First-time init ─────────────────────────────────────────────────────────

init_droplet() {
  log "First-time droplet initialization..."

  ssh "$SSH_USER@$DROPLET_IP" bash <<'REMOTE'
    set -e

    # Install Docker if missing
    if ! command -v docker &>/dev/null; then
      echo "[init] Installing Docker..."
      curl -fsSL https://get.docker.com | sh
      systemctl enable docker
    fi

    # Install Node.js 22 if missing
    if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
      echo "[init] Installing Node.js 22..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
    fi

    # Install Caddy if missing
    if ! command -v caddy &>/dev/null; then
      echo "[init] Installing Caddy..."
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
      apt-get update && apt-get install -y caddy
    fi

    # Install Bifrost if missing
    if ! command -v bifrost &>/dev/null && [ ! -f /root/.cache/bifrost/*/bin/bifrost-http-0 ]; then
      echo "[init] Installing Bifrost..."
      npm install -g @anthropic-ai/bifrost 2>/dev/null || npm install -g @maximhq/bifrost 2>/dev/null || echo "[init] Bifrost install failed — install manually"
    fi

    # Create directories
    mkdir -p /opt/nanoclaw /opt/bifrost /opt/nanoclaw/data /opt/nanoclaw/store /opt/nanoclaw/groups

    # Add swap if missing (prevents OOM on agent builds)
    if [ ! -f /swapfile ]; then
      echo "[init] Adding 2GB swap..."
      fallocate -l 2G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
    fi

    echo "[init] Done. Next: push code with ./deploy/deploy.sh"
REMOTE
}

# ─── Push code ────────────────────────────────────────────────────────────────

push_code() {
  log "Syncing code to ${DROPLET_IP}:${REMOTE_DIR}..."
  rsync -avz --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='data/' \
    --exclude='store/' \
    --exclude='groups/' \
    "$PROJECT_DIR/" "$SSH_USER@$DROPLET_IP:$REMOTE_DIR/"

  log "Installing dependencies..."
  ssh "$SSH_USER@$DROPLET_IP" "cd $REMOTE_DIR && npm ci --production 2>&1 | tail -3"
}

# ─── Build (local) ───────────────────────────────────────────────────────────

build_local() {
  log "Building TypeScript locally..."
  cd "$PROJECT_DIR"
  npm run build
}

# ─── Build container image ────────────────────────────────────────────────────

build_container() {
  log "Building agent container image on droplet..."
  ssh "$SSH_USER@$DROPLET_IP" "cd $REMOTE_DIR && bash container/build.sh 2>&1 | tail -10"
}

# ─── Install services ────────────────────────────────────────────────────────

install_services() {
  log "Installing systemd services..."
  ssh "$SSH_USER@$DROPLET_IP" bash <<REMOTE
    cp $REMOTE_DIR/deploy/nanoclaw.service /etc/systemd/system/
    cp $REMOTE_DIR/deploy/bifrost.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable nanoclaw bifrost caddy
REMOTE
}

# ─── Install configs ─────────────────────────────────────────────────────────

install_configs() {
  log "Installing Caddy + Bifrost configs..."
  ssh "$SSH_USER@$DROPLET_IP" bash <<'REMOTE'
    # Caddy
    if [ -f /opt/nanoclaw/deploy/Caddyfile ]; then
      cp /opt/nanoclaw/deploy/Caddyfile /etc/caddy/Caddyfile
      systemctl reload caddy 2>/dev/null || systemctl restart caddy
    fi

    # Bifrost — expand env vars in template
    if [ -f /opt/nanoclaw/deploy/bifrost-config.template.json ] && [ -f /opt/nanoclaw/.env ]; then
      source /opt/nanoclaw/.env
      export ANTHROPIC_API_KEY OPENAI_API_KEY
      envsubst < /opt/nanoclaw/deploy/bifrost-config.template.json > /opt/bifrost/config.json
      echo "[configs] Bifrost config generated"
    fi
REMOTE
}

# ─── Restart services ────────────────────────────────────────────────────────

restart_services() {
  log "Restarting services..."
  ssh "$SSH_USER@$DROPLET_IP" bash <<'REMOTE'
    systemctl restart bifrost
    sleep 2
    systemctl restart nanoclaw
    sleep 3

    echo "=== Service Status ==="
    systemctl is-active nanoclaw && echo "nanoclaw: ✓" || echo "nanoclaw: ✗"
    systemctl is-active bifrost && echo "bifrost: ✓" || echo "bifrost: ✗"
    systemctl is-active caddy && echo "caddy: ✓" || echo "caddy: ✗"

    echo ""
    echo "=== Memory ==="
    free -m | head -3

    echo ""
    echo "=== NanoClaw Logs ==="
    journalctl -u nanoclaw --no-pager -n 5
REMOTE
}

# ─── Health check ─────────────────────────────────────────────────────────────

health_check() {
  log "Running health checks..."
  ssh "$SSH_USER@$DROPLET_IP" bash <<'REMOTE'
    echo "Services:"
    for svc in nanoclaw bifrost caddy; do
      status=$(systemctl is-active $svc 2>/dev/null || echo "inactive")
      printf "  %-12s %s\n" "$svc" "$status"
    done

    echo ""
    echo "Ports:"
    ss -tlnp | grep -E '4000|443|80' | awk '{print "  " $4}'

    echo ""
    echo "Memory:"
    free -m | awk '/Mem:/{printf "  RAM: %dMB / %dMB (%.0f%%)\n", $3, $2, $3/$2*100}'
    free -m | awk '/Swap:/{printf "  Swap: %dMB / %dMB\n", $3, $2}'

    echo ""
    echo "Docker:"
    docker ps --format '  {{.Names}} | {{.Status}}' 2>/dev/null || echo "  no containers"

    echo ""
    echo "NanoClaw:"
    journalctl -u nanoclaw --no-pager -n 3 --since "1 min ago" 2>/dev/null || echo "  no recent logs"
REMOTE
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-full}" in
  --init)
    check_ssh
    init_droplet
    push_code
    build_container
    install_services
    install_configs
    warn "IMPORTANT: Create /opt/nanoclaw/.env on the droplet. See deploy/env.example"
    warn "Then run: ./deploy/deploy.sh --restart"
    ;;
  --push-only)
    check_ssh
    push_code
    restart_services
    health_check
    ;;
  --container-only)
    check_ssh
    build_container
    ;;
  --restart)
    check_ssh
    restart_services
    health_check
    ;;
  --health)
    check_ssh
    health_check
    ;;
  --configs)
    check_ssh
    install_configs
    restart_services
    ;;
  full|"")
    check_ssh
    build_local
    push_code
    build_container
    install_services
    install_configs
    restart_services
    health_check
    log "Deploy complete!"
    ;;
  *)
    echo "Usage: $0 [--init|--push-only|--container-only|--restart|--health|--configs|full]"
    exit 1
    ;;
esac
