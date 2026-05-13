#!/usr/bin/env bash
#
# Bifrost ACL bootstrap — idempotent re-apply of the two-layer model allowlist.
#
# The Bifrost gateway has two independent allowlists that BOTH must pass before
# a `/anthropic/v1/messages` call routes to an upstream provider:
#
#   LAYER 1 — governance_virtual_key_provider_configs (per-VK provider gate)
#     Failure mode: HTTP 403 "Provider 'anthropic' is not allowed for this virtual key"
#
#   LAYER 2 — config_keys.models_json (per-provider-key model whitelist)
#     Failure mode: HTTP 500 "no keys found that support model: <model-id>"
#
# Layer 1 is also seeded by Delegate's `lib/bifrost.ts` BIFROST_PROVIDERS array
# when new VKs are created — so this script mainly fixes EXISTING VKs that were
# created before that code shipped. Layer 2 is Bifrost-internal admin config
# that Delegate code never touches — this script is the canonical re-apply.
#
# Safe to re-run any time. All operations are idempotent (UPDATE … WHERE that
# already-matches becomes a no-op; INSERT guarded by NOT EXISTS).
#
# Usage:
#   ssh root@159.89.226.182 'bash -s' < deploy/bifrost-bootstrap-acl.sh
#   ssh root@159.89.226.182 'bash /opt/delegate-agent/deploy/bifrost-bootstrap-acl.sh'
#
# Required env (or hard-coded defaults below):
#   BIFROST_DB_PATH   — default /opt/bifrost/config.db
#
# Documentation: Delegate memory `bifrost_two_layer_model_acl.md`.

set -euo pipefail

DB="${BIFROST_DB_PATH:-/opt/bifrost/config.db}"

if [[ ! -f "$DB" ]]; then
  echo "❌ Bifrost config DB not found at $DB"
  exit 1
fi

# Snapshot before mutating.
TS=$(date +%s)
cp "$DB" "$DB.bak-bootstrap-acl-$TS"
echo "✓ Backup: $DB.bak-bootstrap-acl-$TS"

# ─── LAYER 2 — config_keys.models_json ────────────────────────────────────
# Set anthropic provider key's models_json to wildcard. Bifrost rejects mixing
# "*" with explicit values, so this MUST be the lone element.
sqlite3 "$DB" <<'SQL'
UPDATE config_keys
SET models_json = '["*"]'
WHERE provider = 'anthropic'
  AND (models_json IS NULL OR models_json != '["*"]');
SQL
echo "✓ Layer 2: config_keys (provider=anthropic).models_json = [\"*\"]"

# ─── LAYER 1 — governance_virtual_key_provider_configs ────────────────────
# Ensure every existing VK has a row allowing the 'anthropic' provider with
# wildcard model allowlist. New VKs created via Delegate's lib/bifrost.ts
# already get this row inserted by Delegate's BIFROST_PROVIDERS map, but VKs
# created before that ship are missing it.
#
# INSERT … SELECT with anti-join ensures idempotency (no row created if it
# already exists for that virtual_key_id+provider pair).
sqlite3 "$DB" <<'SQL'
INSERT INTO governance_virtual_key_provider_configs
  (virtual_key_id, provider, weight, allowed_models, allow_all_keys)
SELECT vk.id, 'anthropic', 1.0, '["*"]', 1
FROM governance_virtual_keys vk
WHERE NOT EXISTS (
  SELECT 1 FROM governance_virtual_key_provider_configs p
  WHERE p.virtual_key_id = vk.id
    AND p.provider = 'anthropic'
);
SQL
echo "✓ Layer 1: governance_virtual_key_provider_configs anthropic rows inserted (idempotent)"

# Report what's now in place.
echo ""
echo "── Layer 2: per-provider-key model whitelist ──"
sqlite3 -header -column "$DB" 'SELECT provider, name, status, enabled, models_json FROM config_keys ORDER BY provider;'

echo ""
echo "── Layer 1: per-VK anthropic provider rows ──"
sqlite3 -header -column "$DB" \
  'SELECT vk.value AS vk_value, vk.name AS vk_name, p.provider, p.allowed_models, p.allow_all_keys
   FROM governance_virtual_key_provider_configs p
   JOIN governance_virtual_keys vk ON vk.id = p.virtual_key_id
   WHERE p.provider = "anthropic"
   ORDER BY vk.name;'

echo ""
echo "✓ Bootstrap complete. Restart Bifrost for changes to take effect:"
echo "    systemctl restart bifrost"
