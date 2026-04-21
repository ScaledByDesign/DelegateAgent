#!/bin/bash
# Rebrand string substitutions used post-upstream-merge. Idempotent.
# See docs/UPSTREAM-SYNC.md for the full rebrand map.
#
# Usage:
#   ./scripts/apply-rename-map.sh             # apply in place
#   ./scripts/apply-rename-map.sh --dry-run   # show diff without changing files
#
# URL safety (fixed 2026-04-20 per critic #2):
#   - `github.com/qwibitai/nanoclaw`, `qwibitai/nanoclaw.git`, any URL-embedded
#     reference to the upstream repo is PRESERVED via perl negative-lookbehind
#     `(?<![-_/.a-zA-Z0-9])` + negative-lookahead `(?!(\.git|-agent|\.tar|/))`.
#
# Sentry safety (fixed 2026-04-20 per critic #6):
#   - Files whose lines contain `Sentry.startSpan|setTag|addBreadcrumb|startTransaction`
#     with `nanoclaw` arguments are SKIPPED — server-side Sentry grouping relies
#     on those tag names; rewriting them breaks dashboards.
#
# JS identifier safety (fixed 2026-04-21):
#   - `nanoclaw` as a JS object key, property access, variable declaration, or
#     other BARE identifier position is PRESERVED as-is. Hyphenated tokens
#     like `delegate-agent` are invalid JS identifiers (parser reads as
#     `delegate MINUS agent`). Specific places this rule matters:
#       * `mcpServers: { nanoclaw: { ... } }` — MCP wire name, upstream contract
#       * `mcp__nanoclaw__*` — MCP tool allowlist glob
#       * Any `foo.nanoclaw.bar` chain, `nanoclaw(...)` call, `let nanoclaw = ...`
#     These are identifier contexts, not prose. They stay.
#
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=1
fi

find_files() {
  find . -type f \
    \( -name "*.ts" -o -name "*.js" -o -name "*.md" -o -name "*.sh" -o -name "*.json" -o -name "*.yml" -o -name "*.service" -o -name "*.plist" \) \
    ! -path "./node_modules/*" \
    ! -path "./dist/*" \
    ! -path "./.git/*" \
    ! -name "CHANGELOG.md" \
    ! -name "UPSTREAM-SYNC.md" \
    ! -name "package-lock.json" \
    ! -name "apply-rename-map.sh" \
    -print0
}

has_sentry_nanoclaw_tags() {
  grep -lE 'Sentry\.(startSpan|setTag|addBreadcrumb|startTransaction).*nanoclaw' "$1" >/dev/null 2>&1
}

PERL_REWRITE='
  s{/opt/nanoclaw\b}{/opt/delegate-agent}g;
  s{~/\.config/nanoclaw\b}{~/.config/delegate-agent}g;
  # NOTE: NANOCLAW_TOKEN env var rewrite intentionally NOT done here — every
  # remaining occurrence is a legitimate legacy-fallback reference (CHANGELOG,
  # deprecation notices, test cases). The env-var rename landed in PR #1.
  #
  # Context-aware rename:
  #   - JS identifier context (object key, call, member access, MCP namespace):
  #     `nanoclaw` → `delegateagent` (single word, valid JS identifier, valid
  #     MCP server / tool-prefix token).
  #   - All other prose / path / service-unit contexts:
  #     `nanoclaw` → `delegate-agent` (hyphenated external brand).
  #
  # Detection: `nanoclaw:` (object key), `nanoclaw(` (call),
  # `nanoclaw.` (member access), `mcp__nanoclaw__` (MCP tool glob) —
  # all resolve to the single-word form first; everything else resolves
  # to the hyphen form.
  s{(?<![-_/.a-zA-Z0-9])NanoClaw(?!(\.git|-agent|\.tar|/))}{DelegateAgent}g;
  s{(?<![-_/.a-zA-Z0-9])mcp__nanoclaw__}{mcp__delegateagent__}g;
  s{(?<![-_/.a-zA-Z0-9])nanoclaw(?=(:|\(|\.))}{delegateagent}g;
  s{(?<![-_/.a-zA-Z0-9])nanoclaw(?!(\.git|-agent|\.tar|/))}{delegate-agent}g;
'

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[rebrand] DRY RUN — showing diff only, not writing"
  # diff exits 1 when files differ; disable pipefail locally so `diff|head`
  # doesn't abort the loop on the FIRST changed file.
  set +e
  find_files | while IFS= read -r -d '' file; do
    if has_sentry_nanoclaw_tags "$file"; then
      echo "[skip: sentry-tag] $file"
      continue
    fi
    tmp="$(mktemp)"
    perl -pe "$PERL_REWRITE" < "$file" > "$tmp"
    if ! diff -q "$file" "$tmp" >/dev/null 2>&1; then
      echo "=== $file ==="
      diff -u "$file" "$tmp" | head -40
    fi
    rm -f "$tmp"
  done
  set -e
  echo "[rebrand] DRY RUN complete — no files modified"
  exit 0
fi

find_files | while IFS= read -r -d '' file; do
  if has_sentry_nanoclaw_tags "$file"; then
    echo "[skip: sentry-tag] $file"
    continue
  fi
  perl -i.bak -pe "$PERL_REWRITE" "$file"
  rm -f "${file}.bak"
done

echo "[rebrand] apply-rename-map.sh complete — review with 'git diff' before committing"
