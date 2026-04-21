# Merge Policy — Upstream Pulldown 2026-04-20

**Plan:** `.omc/plans/delegateagent-upstream-full-pulldown.md` (rev 2 post-critic)
**Source:** `upstream/main` = qwibitai/nanoclaw @ `a81e165` (2026-04-18)
**Target:** `main` = ScaledByDesign/DelegateAgent @ `36ef1c7`
**Scope:** 659 commits, Feb 1 – Apr 18, 2026

## Credential architecture (§5 resolution)

Current fork state: **hybrid — Tier 1 Delegate per-workspace, Tier 2 OneCLI fallback**. `@onecli-sh/sdk ^0.2.0` is installed; `src/container-runner.ts` invokes both.

Decision: **preserve current ordering**. Merge upstream improvements that extend either tier; do not flip primary/fallback.

## Conflict resolution matrix

| File / surface | Decision | Notes |
|---|---|---|
| `package.json` `name` | Keep ours (`delegate-agent`) | |
| `package.json` `version` | Adopt upstream (`1.2.53`) | Manual bump in P6 |
| `package.json` deps | Union + keep `@onecli-sh/sdk` | Flag any new adds for audit |
| `package-lock.json` | Regenerate in P6 | Never merge lockfile conflicts |
| `src/credential-client.ts` | Keep ours (resurrect if deleted) | Tier-1 primary |
| `src/container-runner.ts` | Hybrid-preserve (see §P3.2c) | Apply security `49e7875` manually if needed |
| `src/config.ts` | Keep `getEnvWithFallback` + `migrateLegacyConfigDir` | Accept upstream adds |
| `src/channels/delegate.ts` | Keep ours entirely | Upstream has no equivalent |
| `src/channels/registry.ts` | Keep `delegate` registration + accept upstream adds | |
| `.env.example`, `deploy/env.example` | Keep `DELEGATE_AGENT_TOKEN` header; NANOCLAW_TOKEN as commented legacy | |
| `deploy/deploy.sh` | Keep migration block intact | |
| `deploy/delegate-agent.service`, `launchd/com.delegate-agent.plist` | Keep ours | No upstream equivalent |
| `deploy/Caddyfile` | Keep title + `"service":"delegate-agent"` body | |
| `sentry-init.cjs` | Keep our Sentry tags | See P4.5 tag audit |
| `README*.md`, `CLAUDE.md`, `CONTRIBUTING.md` | Prose-preserving merge; keep DelegateAgent branding | |
| `CHANGELOG.md` | Manual stitch (P8) | Don't auto-merge |
| `.claude/skills/update-delegate-agent/` | Keep ours | Replaces upstream `update-nanoclaw/` |
| `.claude/skills/migrate-nanoclaw/`, `migrate-from-openclaw/` | DELETE (P5) | Inverse-direction tooling |
| `.claude/skills/*` new additions | Accept; post-merge `apply-rename-map.sh` sweep in P4 | |
| `dist/` | Delete + regenerate in P7 | Never merge build output |
| `eslint.config.js`, `vitest.config.ts` | Accept upstream | |
| `scripts/apply-rename-map.sh` | Keep ours (fixed 2026-04-20 pre-merge) | |

## Phased merge buckets (§P3.0)

| # | Bucket | Commits (pattern) | Estimated conflict hotness |
|---|--------|-------------------|-----------------------------|
| B1 | Agent SDK upgrade | `db3440f` 1M ctx, deps bumps | MEDIUM — package.json |
| B2 | Session recovery + auto-prune | `67020f9`, `001ee6e`, `38009be`, `474346e` | LOW |
| B3 | Security: only-expose-auth-vars | `49e7875` | HIGH — container-runner.ts |
| B4 | Script exec in ContainerInput | `9f5aff9`, `0f283cb`, `675acff`, `42d098c`, `a516cc5` | MEDIUM |
| B5 | Logger swap (pino → built-in) | `5702760` and follow-ups | LOW |
| B6 | New skills + channel features | channel-formatting, emacs, add-wiki, remote-control, reply context | MEDIUM |
| B7 | Everything else | docs, CHANGELOG, ESLint, misc fixes | LOW |

**Fallback:** If bucketing proves intractable, fall back to single `git merge --no-ff upstream/main`; document reason here.

## Safety tags

- `pre-rebrand-20260420` → furthest rollback
- `pre-upstream-merge-20260420` → pre-pulldown safe point (placed in P0)
- Working branch: `merge/upstream-20260418`

## Verification trail

All 20 AC items tracked in the plan. Key instrumentation files end up in `.omc/research/`:
- `deps-pre-merge.txt` / `deps-diff.txt`
- `upstream-diff-stats.txt` / `upstream-new-files.txt` / `upstream-deleted-files.txt` / `upstream-new-skills.txt`
- `rename-map-dryrun.txt` / `sentry-tags-post-rename.txt`
- `credential-client-pre-merge.ts.bak` (resurrection source)
