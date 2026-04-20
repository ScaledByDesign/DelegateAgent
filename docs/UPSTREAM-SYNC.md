# Upstream-Sync Strategy — DelegateAgent Fork

This repo is a fork of [`qwibitai/nanoclaw`](https://github.com/qwibitai/nanoclaw), rebranded to **DelegateAgent**. The upstream project is still called NanoClaw and continues to ship features we want to consume.

## Remotes

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream
```

## Rebrand map

When merging an upstream change, apply this string map to avoid re-introducing the old name into renamed files. The `scripts/apply-rename-map.sh` helper (created in P1) automates most of this.

| Category | Upstream (NanoClaw) | DelegateAgent |
|---|---|---|
| Package name | `nanoclaw` | `delegate-agent` |
| Env var | `NANOCLAW_TOKEN` | `DELEGATE_AGENT_TOKEN` (legacy var read as fallback for one release) |
| Install path | `/opt/nanoclaw` | `/opt/delegate-agent` (symlink kept for one release) |
| Config dir | `~/.config/nanoclaw` | `~/.config/delegate-agent` (runtime migration on first boot) |
| systemd unit | `nanoclaw.service` | `delegate-agent.service` |
| launchd label | `com.nanoclaw` | `com.delegate-agent` |
| Container image tag | `nanoclaw:latest` | `delegate-agent:latest` |
| Skill dir | `.claude/skills/update-nanoclaw/` | `.claude/skills/update-delegate-agent/` |
| Slash-command | `/update-nanoclaw` | `/update-delegate-agent` (legacy alias kept) |
| Prose — project noun | `NanoClaw` | `DelegateAgent` |
| Prose — binary/service | `nanoclaw` | `delegate-agent` |

## Intentional residuals (do NOT rename)

These references are correct as-is because they point at upstream concepts, history, or licensing:

- `CHANGELOG.md` — historical entries that describe the project when it was named NanoClaw
- `LICENSE` — upstream copyright holder attribution
- `docs/UPSTREAM-SYNC.md` — this file; references the upstream name repeatedly
- `.claude/skills/claw/SKILL.md` — teaches the upstream `/claw` CLI tool pattern; upstream name is part of the public interface
- `.claude/skills/update-delegate-agent/SKILL.md` — describes how to consume upstream `qwibitai/nanoclaw` updates; the upstream name is explicitly required
- Generated artifacts in `dist/` and `node_modules/`

## Merge workflow

```bash
# 1. Fetch upstream
git fetch upstream

# 2. Merge into a staging branch
git checkout -b merge/upstream-$(date +%Y%m%d)
git merge upstream/main  # resolve upstream-specific conflicts normally

# 3. Apply the rebrand map to any new strings the merge introduced
./scripts/apply-rename-map.sh

# 4. Run typecheck and tests
npm run typecheck && npm run test && npm run build

# 5. Open a PR against rename/delegate-agent (or current release branch)
```

## Rollback

If a rebrand change needs to be undone, the pre-rebrand state is tagged at `pre-rebrand-20260420` on `origin`. Restore with:

```bash
git checkout pre-rebrand-20260420 -- <path>
```

## References

- Original fork point: `main` at commit `9d2cbf7` (feat: commit deploy script + loud startup log + CI build check)
- Tag `pre-rebrand-20260420` → `9d2cbf7`
- Rename work lives on branch `rename/delegate-agent`
