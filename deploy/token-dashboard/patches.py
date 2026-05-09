#!/usr/bin/env python3
"""
Apply DelegateAgent-specific patches to upstream token-dashboard.

Why this exists:
  Our symlink-flattener creates symlinks from /aggregated-projects/<group>__<slug>
  to the real per-group .claude/projects/<slug>/ directories. Upstream's
  scanner uses pathlib.Path.rglob('*.jsonl'), which in Python 3.12 does NOT
  follow symlinks during recursive traversal — so the scanner finds zero files
  and the dashboard shows zero data. Python 3.13 adds `recurse_symlinks=True`,
  but token-dashboard pins on 3.12.

  Minimal-surgery fix: insert a tiny generator using os.walk(followlinks=True)
  at the top of scanner.py, and swap the one rglob call to use it. The rest
  of the scanner's logic (per-file stat, dedup by message.id) is untouched.

Idempotent: running twice is a no-op once the patch is applied.
"""

from __future__ import annotations
import pathlib
import sys

HELPER = '''
# DelegateAgent patch: rglob doesn't follow symlinks in Python 3.12 (added in
# 3.13 as recurse_symlinks=True). Our /aggregated-projects layout uses symlinks
# to per-group dirs, so we replace rglob with os.walk(followlinks=True).
def _walk_jsonl_followlinks(root):
    import os, pathlib as _pl
    for _d, _, _fs in os.walk(root, followlinks=True):
        for _f in _fs:
            if _f.endswith(".jsonl"):
                yield _pl.Path(_d) / _f
# end DelegateAgent patch
'''

PATCHES = [
    {
        "file": "/app/token_dashboard/scanner.py",
        "marker": "_walk_jsonl_followlinks",  # presence = already patched
        "edits": [
            # 1. Insert helper after the first import line
            {
                "kind": "insert_after",
                "anchor": "import pathlib",
                "text": HELPER,
            },
            # 2. Swap the rglob call
            {
                "kind": "replace",
                "old": 'for p in root.rglob("*.jsonl"):',
                "new": "for p in _walk_jsonl_followlinks(root):",
            },
        ],
    },
]


def apply_edits(src: str, edits: list[dict]) -> str:
    for edit in edits:
        kind = edit["kind"]
        if kind == "replace":
            if edit["old"] not in src:
                raise SystemExit(f"patch failed: anchor not found: {edit['old']!r}")
            src = src.replace(edit["old"], edit["new"], 1)
        elif kind == "insert_after":
            anchor = edit["anchor"]
            idx = src.find(anchor)
            if idx < 0:
                raise SystemExit(f"patch failed: anchor not found: {anchor!r}")
            # Insert after the line containing the anchor
            line_end = src.find("\n", idx)
            line_end = line_end + 1 if line_end >= 0 else len(src)
            src = src[:line_end] + edit["text"] + src[line_end:]
        else:
            raise SystemExit(f"unknown edit kind: {kind}")
    return src


def main():
    for patch in PATCHES:
        path = pathlib.Path(patch["file"])
        if not path.exists():
            print(f"[patches] SKIP {path}: not found")
            continue
        src = path.read_text()
        if patch["marker"] in src:
            print(f"[patches] SKIP {path}: already patched")
            continue
        new_src = apply_edits(src, patch["edits"])
        path.write_text(new_src)
        print(f"[patches] applied: {path}")


if __name__ == "__main__":
    main()
