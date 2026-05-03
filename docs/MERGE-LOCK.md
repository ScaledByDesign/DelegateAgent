# MERGE_LOCK Sentinel

## What is MERGE_LOCK?

`MERGE_LOCK` is a sentinel file that tells the `scripts/auto-update.sh` script to skip pulling new changes from the remote repository. This is used during large merges (like upstream synchronization) to prevent droplets from auto-pulling halfway through a multi-commit release.

## When to use MERGE_LOCK

1. Engineer prepares a release branch with a large merge (e.g., upstream nanoclaw sync).
2. Engineer commits `MERGE_LOCK` to the release branch to freeze all droplet auto-updates.
3. Engineer manually validates the merge on a staging droplet without interference from auto-update.
4. Engineer removes `MERGE_LOCK` in the final merge commit before landing on `main`.
5. CI guard on `main` catches any forgotten `MERGE_LOCK` files and fails the job.

## Workflow

### Committing MERGE_LOCK (release engineer)

```bash
# On release branch, before first droplet push
touch MERGE_LOCK
git add MERGE_LOCK
git commit -m "chore: lock auto-update during upstream merge"
```

### How it works on droplets

The file must be located at `$AGENT_DIR/MERGE_LOCK`, which is `/opt/remote-agent/MERGE_LOCK` by default (configured via `REMOTE_AGENT_DIR` environment variable in cron or systemd timer).

When `scripts/auto-update.sh` runs (typically every minute via cron), it checks:
```bash
if [ -f "$AGENT_DIR/MERGE_LOCK" ]; then
  echo "[remote-agent-update] MERGE_LOCK present at $AGENT_DIR/MERGE_LOCK — skipping pull"
  exit 0
fi
```

If present, the script exits cleanly without pulling or rebuilding.

### Removing MERGE_LOCK (release engineer)

```bash
# In final merge commit before landing on main
git rm MERGE_LOCK
git commit -m "chore: unlock auto-update post-merge"
```

## CI Guard

A GitHub Actions workflow `.github/workflows/merge-lock-guard.yml` runs on every push and PR to `main`. It fails the job if `MERGE_LOCK` exists:

```bash
test ! -f MERGE_LOCK || (echo "MERGE_LOCK must not be on main" && exit 1)
```

This prevents accidental commits of `MERGE_LOCK` to the main branch.

## Testing (Staging Droplet)

To verify MERGE_LOCK works on a staging droplet:

```bash
ssh delegate-core "cd ${REMOTE_AGENT_DIR:-/opt/remote-agent} && touch MERGE_LOCK && bash scripts/auto-update.sh; echo exit=\$?; rm MERGE_LOCK"
```

Expected output:
- `[remote-agent-update] MERGE_LOCK present at /opt/remote-agent/MERGE_LOCK — skipping pull`
- `exit=0`
- No `git pull` output

After removing the lock and re-running, the script should pull normally.
