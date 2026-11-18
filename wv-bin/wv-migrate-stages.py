#!/usr/bin/env python3
"""wv-migrate-stages.py [--dry] [--force] [--pause] [<project-root> ...]

One-time, idempotent move of existing tickets to the stage pipeline (Draft - Plan - Design - Todo - Building - Review - Deliver - Done).
Every ticket that is not `done` becomes `draft`, so the owner dispatches each one by hand and tests alone; `done` stays done.
Nothing is deleted: worktrees, branches, ledger, results and rd.md files are left as they are, only the status word changes.
BOARD.md is copied to BOARD.md.bak-stages-<time> first. A ticket that has a live worker is skipped (and reported).
A project is migrated once (job/stages-v2.migrated); --force runs it again. --pause also creates job/fleet-off so nothing starts
until the owner switches the fleet on. Without a project folder it migrates every project in ~/.workov/fleets.json plus the current folder.
Run by install.sh; callable by hand."""
import importlib.util
import json
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location("wv_stage", HERE / "wv-stage.py")
stg = importlib.util.module_from_spec(_s)
_s.loader.exec_module(stg)
LEGEND = "Status: `draft` | `specifying` | `designing` | `todo` | `ready` | `in-progress` | `in-review` | `delivering` | `done` | `blocked` | `failed` | `budget-exceeded`."


def migrate(root, dry, force, pause):
    base = Path(root)
    bp = stg.board_path(root)
    if not bp.is_file():
        return "no board"
    marker = base / "job" / "stages-v2.migrated"
    if marker.exists() and not force:
        return "already migrated"
    live = stg.live_tickets(root)
    plan = []
    for r in stg.rows(root):
        if r["status"] in ("done", "draft"):
            continue
        if r["id"] in live:
            plan.append((r["id"], r["status"], None))
        else:
            plan.append((r["id"], r["status"], "draft"))
    lines = [("  " + t + ": " + s + " -> " + (n or "SKIPPED, a worker is live")) for t, s, n in plan]
    if dry:
        return "would change %d ticket(s)\n%s" % (len([p for p in plan if p[2]]), "\n".join(lines))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    shutil.copy2(bp, bp.with_name("BOARD.md.bak-stages-" + stamp))
    for tid, _, new in plan:
        if new:
            stg.set_status(root, tid, new, stage="draft")
    for r in stg.rows(root):  # done tickets get their stage record too, so the card knows where it stands
        if r["status"] == "done" and not stg.load_sf(root, r["id"]):
            stg.set_status(root, r["id"], "done", stage="done")
    text = bp.read_text(encoding="utf-8")
    t2 = re.sub(r"^Status:.*$", lambda m: LEGEND, text, count=1, flags=re.M)
    if t2 != text:
        stg.write_atomic(bp, t2)
    if pause:
        (base / "job").mkdir(exist_ok=True)
        (base / "job" / "fleet-off").write_text("stage migration: switch the fleet on when you are ready\n", encoding="utf-8")
    (base / "job").mkdir(exist_ok=True)
    marker.write_text(json.dumps({"at": stg.now(), "changed": [p[0] for p in plan if p[2]], "skippedLive": [p[0] for p in plan if not p[2]]}) + "\n", encoding="utf-8")
    return "migrated %d ticket(s) to draft (backup BOARD.md.bak-stages-%s)\n%s" % (len([p for p in plan if p[2]]), stamp, "\n".join(lines))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    roots = args
    if not roots:
        roots = [str(Path.cwd())]
        try:
            for it in json.loads((Path.home() / ".workov" / "fleets.json").read_text(encoding="utf-8")):
                if isinstance(it, dict) and it.get("root"):
                    roots.append(it["root"])
        except Exception:
            pass
    seen = set()
    for root in roots:
        key = str(Path(root).resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        print(root + ": " + migrate(root, "--dry" in flags, "--force" in flags, "--pause" in flags))
    return 0


if __name__ == "__main__":
    sys.exit(main())
