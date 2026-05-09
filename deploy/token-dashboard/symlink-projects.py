#!/usr/bin/env python3
"""
Flatten DelegateAgent's two-level transcript layout into the single-level
layout token-dashboard expects.

Source layout (read-only mount):
    /data/sessions/<group>/.claude/projects/<project-slug>/<session-id>.jsonl

Target layout (token-dashboard scans this):
    /aggregated-projects/<group>__<project-slug>/<session-id>.jsonl

Each <group>__<project-slug> is a symlink to the underlying project dir,
so JSONL files appear as if they live in a flat "projects" directory.
The "<group>__" prefix surfaces channel attribution in the dashboard's
"Projects" tab without forking the upstream scanner.

Idempotent: re-running prunes stale symlinks (group or project dir
removed upstream) and adds new ones.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SESSIONS_DIR = Path(os.environ.get("SESSIONS_DIR", "/data/sessions"))
AGGREGATED_DIR = Path(os.environ.get("AGGREGATED_DIR", "/aggregated-projects"))


def discover_project_dirs() -> dict[str, Path]:
    """Return {<group>__<slug>: <abs source path>} for every project found."""
    out: dict[str, Path] = {}
    if not SESSIONS_DIR.is_dir():
        return out

    for group_dir in sorted(SESSIONS_DIR.iterdir()):
        if not group_dir.is_dir():
            continue
        projects_dir = group_dir / ".claude" / "projects"
        if not projects_dir.is_dir():
            continue
        for project_dir in sorted(projects_dir.iterdir()):
            if not project_dir.is_dir():
                continue
            # token-dashboard project slugs are already URL-safe (Claude Code
            # generates them by replacing path separators with hyphens), so
            # this concatenation stays unambiguous.
            key = f"{group_dir.name}__{project_dir.name}"
            out[key] = project_dir.resolve()
    return out


def sync(target_dir: Path, wanted: dict[str, Path]) -> tuple[int, int, int]:
    target_dir.mkdir(parents=True, exist_ok=True)

    existing: dict[str, Path] = {}
    for entry in target_dir.iterdir():
        if entry.is_symlink():
            existing[entry.name] = entry

    added = 0
    removed = 0
    refreshed = 0

    # Remove or refresh stale symlinks.
    for name, link in existing.items():
        wanted_target = wanted.get(name)
        current_target = Path(os.readlink(link)) if link.is_symlink() else None
        if wanted_target is None:
            link.unlink()
            removed += 1
        elif current_target != wanted_target:
            link.unlink()
            link.symlink_to(wanted_target)
            refreshed += 1

    # Create missing symlinks.
    for name, source in wanted.items():
        link = target_dir / name
        if not link.exists() and not link.is_symlink():
            link.symlink_to(source)
            added += 1

    return added, removed, refreshed


def main() -> int:
    wanted = discover_project_dirs()
    added, removed, refreshed = sync(AGGREGATED_DIR, wanted)
    if added or removed or refreshed:
        print(
            f"[symlink-projects] groups={len(set(k.split('__', 1)[0] for k in wanted))} "
            f"projects={len(wanted)} added={added} removed={removed} refreshed={refreshed}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
