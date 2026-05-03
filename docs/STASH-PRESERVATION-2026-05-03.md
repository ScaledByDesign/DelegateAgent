# Droplet Stash Preservation — 2026-05-03

During the 2026-05-03 gap-closure deploy to `agent.delegate.ws` (159.89.226.182), four `git stash` entries were found on the droplet's `/opt/delegate-agent` working copy. After audit, all four were either redundant with current `main` HEAD or represented older WIP states. To preserve them irreversibly even if `git stash drop` is run, each stash commit was tagged on the droplet's local refs/tags/*. The droplet currently has no GitHub push credentials (auto-update.sh only pulls), so these tags live droplet-locally; this document is the durable manifest.

## Preserved stash commits

| Tag (on droplet) | Commit SHA | Parent (origin) | Stash subject | Audit verdict |
|---|---|---|---|---|
| `droplet-predeploy-2026-05-03` | `04e433ef903a8699c2afd33d693843b2b03f0c2c` | `838e8df` | `predeploy-1777769921` (created during this deploy) | Redundant — only 3 files diverged vs HEAD, all OLDER versions superseded by gap-closure commits + my 3 follow-up fixes (`0e7ea04`, `3f1a35e`, `661846c`). Stash @{0} dropped from stack. |
| `stash-restore-1-20260503` | `dfd98f8e163b7bb6e9a1bd4c61c085820f2290fb` | `42d86b2c` (`feat(chat): add console.log tracing for fastpath outcomes`) | `WIP on main` from 2026-05-03 00:00:22 UTC | Pre-existed on droplet. Only `src/chat/dispatch.ts` had unique content — and it was the OLDER version before commit `838e8df` ("fix(chat): strip task-context preamble"). Other 4 files (`bifrost-client.ts`, `heuristic.ts`, `index.ts`, `types.ts`) were byte-identical to HEAD. Left on stack as it predates this session. |
| `stash-restore-2-20260420` | `7c4cf12b9d037e64265442e044fe3ba3dbb67f5a` | `pre-origin-swap-20260420-235026` | `On main` from 2026-04-20 23:50:26 UTC | Pre-existed on droplet. Predates the OpenClaw → DelegateAgent rebrand. Diff shows pre-rebrand `src/channels/index.ts` and `src/types.ts` (21 + 24 lines). Superseded by rebrand commits. Left on stack. |
| `stash-restore-3-20260409` | `1dee2615e3750fe846b80ba647be9ba7553c715d` | `2983946` (`fix: setup skill skips /use-native-credential-proxy for apple container`) | `WIP on main` from 2026-04-09 | Pre-existed on droplet. Very old WIP from April 9 covering 11 files including `package.json`, `package-lock.json`, `src/container-runner.ts`, `src/db.ts`, `src/index.ts`. Most diff is forward main progress, not unique work. Left on stack. |

## Recovery procedure

From any clone with droplet SSH access:

```bash
ssh root@159.89.226.182 'cd /opt/delegate-agent && git show <tag-name>'
ssh root@159.89.226.182 'cd /opt/delegate-agent && git stash apply <tag-name>'
```

Or pull the commit object back to local for inspection:

```bash
git fetch ssh://root@159.89.226.182/opt/delegate-agent <tag-name>:refs/heads/inspect-<tag-name>
git log inspect-<tag-name>
```

## Why the droplet can't push tags to origin

The droplet's `auto-update.sh` only ever runs `git pull origin main --ff-only` — there is no GitHub credential helper or PAT installed. `git push` from `/opt/delegate-agent` fails with:

```
fatal: could not read Username for 'https://github.com': No such device or address
```

This is intentional in the deploy topology: the droplet is a *consumer* of `main`, never a *producer*. If push capability is ever needed (e.g. to upstream stash refs as backup), set up a deploy key or fine-grained PAT in `~root/.git-credentials`.

## Audit summary

All four stashes are GC-proof while the droplet exists. None contained unique work that wasn't already in `main` or in proper commits. The preservation is belt-and-suspenders for paranoia, not because anything was at risk of being lost.
