#!/usr/bin/env python3
"""wv-settle.py [--dry]

An answer on the dashboard (specs/tickets/<ticket>/user-decision.md) is only ever read by a LIVE worker. When the ticket's
worker is gone (it finished, died or ran out of retries) nothing reads it and the ticket stays blocked for ever.
For every registered project this hands such an answer back to the pipeline, once:
  - ticket in pendingDecisions (or `blocked`/`specifying` on the board) with a user-decision.md newer than its forwarded
    record and NO live worker session  ->  the old worker entry is dropped, the ticket's retries start again (a human
    answer is new information), the answer is recorded as forwarded, and the board row becomes
        specifying -> draft   (the answers go to the planner; the user dispatches)
        blocked    -> ready   (the router dispatches a fresh worker, which reads user-decision.md)
Run by router-loop.sh before every router turn, so it costs no model call."""
import importlib.util
import json
import os
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("wv_sessions", HERE / "wv-sessions.py")
ws = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ws)


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=str(Path(path).parent), prefix=".wv-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def set_board(root, num, status):
    """The one write path of a ticket's status lives in wv-stage.py (board row, rd.md header, stage record)."""
    sp = importlib.util.spec_from_file_location("wv_stage", HERE / "wv-stage.py")
    stg = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(stg)
    if stg.row(root, num):
        stg.set_status(root, num, status)


def answered_target(root, num, status):
    """Where an answered ticket goes: back to the stage it was in. A ticket the planner was writing stays `specifying` (its
    session is resumed): `draft` would tell the stage pipeline that the planner finished."""
    sp = importlib.util.spec_from_file_location("wv_stage", HERE / "wv-stage.py")
    stg = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(stg)
    if status == "specifying":
        return "specifying"
    return stg.ENTRY_STATUS.get(stg.stage_of(status, stg.load_sf(root, num)), "ready")


def replan(base, slug, num, dec):
    """the planner's open questions were answered: resume its session with the answer (a headless fleet job, no router)"""
    import subprocess
    out = base / "job" / ("plan-" + num + ".out")
    sid = None
    try:
        found = re.findall(r"PLANNER_SESSION\s+([0-9a-f-]{36})", out.read_text(encoding="utf-8", errors="replace"))
        sid = found[-1] if found else None
    except OSError:
        pass
    if not sid or not (base / ".claude" / "scripts" / "plan.cjs").is_file():
        return
    log = open(base / "job" / ("plan-" + num + ".out"), "a", encoding="utf-8")
    flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0
    subprocess.Popen(["node", ".claude/scripts/plan.cjs", slug, "--resume", sid, "--answer", str(dec)], cwd=str(base), stdout=log, stderr=log,
                     stdin=subprocess.DEVNULL, creationflags=flags)
    print("  planner resumed for " + slug)


def stale_heartbeats(base, num):
    import subprocess
    dirs = [base]
    try:
        out = subprocess.run(["git", "-C", str(base), "worktree", "list", "--porcelain"], capture_output=True, text=True, timeout=20).stdout
        dirs += [Path(l[9:].strip()) for l in out.splitlines() if l.startswith("worktree ")]
    except Exception:
        pass
    found = []
    for d in dirs:
        for f in list((d / "job").glob("status*.json")) if (d / "job").is_dir() else []:
            if str(ws.read_json(f).get("ticket", "")).startswith(num):
                found.append(f)
    return found


def archive_old_results(name, root, board, dry):
    """A ticket the owner just made `ready` again starts a NEW run. Its results.md / results.json from the earlier run (often a
    "Failed attempt summary ... 3/3") make the router judge the new run as already failed before a worker started: move them to
    attempts/ (kept as history) so the router sees a clean ticket."""
    import shutil
    from datetime import datetime, timezone
    base = Path(root)
    state = ws.read_json(base / "job" / "router-state.json")
    running = {str(e.get("ticket", ""))[:3] for e in state.get("dispatched", []) or [] if isinstance(e, dict)}
    for d in sorted((base / "specs" / "tickets").glob("[0-9][0-9][0-9]-*")):
        num = d.name[:3]
        if board.get(num) != "ready" or num in running or num in {s["ticket"] for s in ws.live(root)}:
            continue
        old = [f for f in (d / "results.md", d / "results.json") if f.is_file()]
        beats = stale_heartbeats(base, num)
        if not old and not beats:
            continue
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        print(name + ": " + d.name + " is ready again: earlier results moved to ~/.workov/history/" + stamp)
        if dry:
            continue
        for b in beats:
            # the worker heartbeat of the finished run ("attempt 3, done") would make the router count the new run as attempt 4
            b.replace(b.with_name(b.name + ".prev-" + stamp))
        # history lives outside the ticket folder: a router that finds old results next to the ticket judges the new run by them
        hist = Path.home() / ".workov" / "history" / Path(root).name / d.name
        hist.mkdir(parents=True, exist_ok=True)
        for f in old:
            shutil.move(str(f), str(hist / (f.stem + "-" + stamp + f.suffix)))
        sp = base / "job" / "router-state.json"
        st = ws.read_json(sp)
        st.setdefault("budgetSince", {})[num] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        write_atomic(sp, json.dumps(st, indent=2) + chr(10))


def settle(name, root, dry):
    base = Path(root)
    sp = base / "job" / "router-state.json"
    state = ws.read_json(sp)
    board = ws.board_status(root)
    liveno = {s["ticket"] for s in ws.live(root)}
    forwarded = state.get("forwardedDecisions", []) or []
    done_paths = {f.get("path"): f.get("submitted") for f in forwarded if isinstance(f, dict)}
    changed = False
    cands = set(str(x) for x in state.get("pendingDecisions", []) or [])
    for d in (base / "specs" / "tickets").glob("[0-9][0-9][0-9]-*"):
        if board.get(d.name[:3]) in ("blocked", "specifying"):
            cands.add(d.name)
    for slug in sorted(cands):
        num = slug[:3]
        dec = base / "specs" / "tickets" / slug / "user-decision.md"
        if not dec.is_file() or num in liveno:
            continue
        text = dec.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"\*\*Submitted:\*\*\s*(\S+)", text)
        submitted = m.group(1) if m else str(int(dec.stat().st_mtime))
        rel = "specs/tickets/" + slug + "/user-decision.md"
        if done_paths.get(rel) == submitted:
            continue
        status = board.get(num, "")
        target = answered_target(root, num, status)
        print(name + ": answer for " + slug + " has no live worker: " + (status or "?") + " -> " + target + ", retries reset")
        if dry:
            continue
        state["pendingDecisions"] = [x for x in state.get("pendingDecisions", []) or [] if x != slug]
        state["dispatched"] = [e for e in state.get("dispatched", []) or [] if not (isinstance(e, dict) and str(e.get("ticket", "")).startswith(num))]
        state["paused"] = [x for x in state.get("paused", []) or [] if not str(x).startswith(num)]
        forwarded = [f for f in forwarded if not (isinstance(f, dict) and f.get("path") == rel)]
        forwarded.append({"path": rel, "submitted": submitted})
        state["forwardedDecisions"] = forwarded
        if status in ("blocked", "specifying", "failed", "budget-exceeded"):
            set_board(root, num, target)
        if status == "specifying":
            replan(base, slug, num, dec)
        changed = True
    if changed:
        from datetime import datetime, timezone
        state["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        write_atomic(sp, json.dumps(state, indent=2) + "\n")


def main():
    dry = "--dry" in sys.argv
    for name, root in ws.fleets():
        try:
            archive_old_results(name, root, ws.board_status(root), dry)
            settle(name, root, dry)
        except Exception as e:
            print(name + ": settle failed: " + str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
