#!/bin/bash
# Rebrand string substitutions used post-upstream-merge. Idempotent.
# See docs/UPSTREAM-SYNC.md for the full rebrand map.
set -euo pipefail

# Only operate on source + deploy + docs; never on node_modules, dist, .git, CHANGELOG.md
FIND_ARGS=(
  -type f
  \( -name "*.ts" -o -name "*.js" -o -name "*.md" -o -name "*.sh" -o -name "*.json" -o -name "*.yml" -o -name "*.service" -o -name "*.plist" \)
  ! -path "./node_modules/*"
  ! -path "./dist/*"
  ! -path "./.git/*"
  ! -name "CHANGELOG.md"
  ! -name "UPSTREAM-SYNC.md"
  ! -name "package-lock.json"
)

find . "${FIND_ARGS[@]}" -print0 | while IFS= read -r -d '' file; do
  # Prose — project noun
  sed -i.bak "s/NanoClaw/DelegateAgent/g" "$file"
  # Prose — binary/service
  sed -i.bak "s/\\bnanoclaw\\b/delegate-agent/g" "$file"
  # Paths (avoid matching inside URLs like github.com/qwibitai/nanoclaw)
  sed -i.bak "s|/opt/nanoclaw\\b|/opt/delegate-agent|g" "$file"
  sed -i.bak "s|~/.config/nanoclaw|~/.config/delegate-agent|g" "$file"
  # Env var
  sed -i.bak "s/NANOCLAW_TOKEN/DELEGATE_AGENT_TOKEN/g" "$file"
  # Cleanup backup files
  rm -f "${file}.bak"
done

echo "[rebrand] apply-rename-map.sh complete — review with 'git diff' before committing"
