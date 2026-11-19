#!/usr/bin/env python3
"""wv-plan.py [--dry] [--status]

Writes the specs of tickets that are `specifying` but have no writer. A ticket created from a brief (job/briefs/NNN.md) is only a
stub until its writer (.claude/scripts/plan.cjs) runs; nothing used to start that writer, so the ticket looked "being written" for
ever. This starts the writers, zero tokens until a writer actually runs, in ticket order. Writers share the one agent limit
(concurrency.maxParallelWorkers) with workers, designers and reviewers: a writer starts only into a free slot.
--status prints, per ticket, what the dashboard shows: writing | waiting for a slot | needs you."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import importlib.util
_s = importlib.util.spec_from_file_location("wv_sessions", HERE / "wv-sessions.py")
ws = importlib.util.module_from_spec(_s)
_s.loader.exec_module(ws)


def procs():
    if os.name != "nt":
        return []
    cmd = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'plan.cjs' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=60).stdout
    try:
        d = json.loads(out)
    except Exception:
        return []
    return d if isinstance(d, list) else [d]


def cap():
    hub = ws.read_json(Path.home() / ".workov" / "hub.json").get("root", "")
    c = ws.read_json(Path(hub) / "specs" / "worker-fleet.config.json").get("concurrency", {}) if hub else {}
    try:
        return max(1, int(c.get("maxParallelWorkers", 1)))
    except (TypeError, ValueError):
        return 1


def tickets(root):
    base = Path(root)
    board = ws.board_status(root)
    out = []
    for d in sorted((base / "specs" / "tickets").glob("[0-9][0-9][0-9]-*")):
        num = d.name[:3]
        if board.get(num) != "specifying":
            continue
        brief = base / "job" / "briefs" / (num + ".md")
        hb = ws.read_json(base / "job" / ("status-writer-" + num + ".json"))
        rd = d / "rd.md"
        size = rd.stat().st_size if rd.is_file() else 0
        out.append({"num": num, "slug": d.name, "brief": brief if brief.is_file() else None, "phase": str(hb.get("phase", "")), "size": size,
                    "hb": bool(hb), "root": root})
    return out


def state_of(t, running):
    if (t["root"], t["num"]) in running:
        return "writing"
    if t["hb"] and t["phase"] in ("done", "waiting-user") and t["size"] > 1500:
        return "needs you"
    return "waiting for a slot" if t["brief"] else "no brief"


def running_set(plist, items):
    run = set()
    for p in plist:
        cl = (p.get("CommandLine") or "").replace("\\", "/")
        m = re.search(r"plan\.cjs\s+(\d{3})-", cl)
        if m:
            for _, root in items:
                run.add((root, m.group(1)))  # a writer runs in one project; matched below by its heartbeat folder
    return run


def limit_hit(root, num):
    """the writer's last run ended on the Claude plan's usage limit: do not start it again before the reset (it would die at once)"""
    import time
    log = Path(root) / 'job' / 'logs' / (num + '-planner.log')
    try:
        tail = log.read_text(encoding='utf-8', errors='replace')[-3000:]
    except OSError:
        return False
    return 'hit your' in tail and 'limit' in tail and time.time() - log.stat().st_mtime < 5 * 3600


def resume_with_answer(root, t, dry):
    """A planner that ended `waiting-user` asked the owner something. The owner answers in the dashboard (it writes the ticket's
    user-decision.md); an answer newer than the writer's heartbeat is written to job/briefs/NNN-answers.md and the planner is resumed with it
    (plan.cjs --resume <session> --answer <file>). Returns True when it started the planner."""
    base = Path(root)
    dec = base / "specs" / "tickets" / t["slug"] / "user-decision.md"
    hbf = base / "job" / ("status-writer-" + t["num"] + ".json")
    if not dec.is_file() or not hbf.is_file() or dec.stat().st_mtime <= hbf.stat().st_mtime:
        return False
    log = base / "job" / "logs" / (t["num"] + "-planner.log")
    try:
        ids = re.findall(r"--resume ([0-9a-f-]{36})", log.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return False
    if not ids:
        return False
    text = dec.read_text(encoding="utf-8", errors="replace").split("## Instructions", 1)[-1].strip()
    print(base.name + ": resuming the writer of " + t["slug"] + " with the owner's answer")
    if dry:
        return True
    ans = base / "job" / "briefs" / (t["num"] + "-answers.md")
    ans.write_text("The owner's answer to your open questions (from the dashboard):" + chr(10) * 2 + text + chr(10), encoding="utf-8")
    out = open(base / "job" / ("plan-" + t["num"] + ".out"), "a", encoding="utf-8")
    flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0
    subprocess.Popen(["node", ".claude/scripts/plan.cjs", t["slug"], "--resume", ids[-1], "--answer", str(ans.relative_to(base)).replace(chr(92), "/")], cwd=root,
                     stdout=out, stderr=out, stdin=subprocess.DEVNULL, creationflags=flags)
    return True


def main():
    dry = "--dry" in sys.argv
    items = ws.fleets()
    plist = procs()
    live_writers = []
    for p in plist:
        m = re.search(r"plan\.cjs\s+(\d{3})-", (p.get("CommandLine") or "").replace("\\", "/"))
        if m:
            live_writers.append(m.group(1))
    # attribute running writers to a project by a fresh writer heartbeat
    import time
    running = set()
    for name, root in items:
        for t in tickets(root):
            hbf = Path(root) / "job" / ("status-writer-" + t["num"] + ".json")
            fresh = hbf.is_file() and time.time() - hbf.stat().st_mtime < 300
            if t["num"] in live_writers and (fresh or not t["hb"]):
                running.add((root, t["num"]))
    status = "--status" in sys.argv
    # planning shares the one agent limit with building, designing and review (concurrency.maxParallelWorkers, default 4)
    free = ws.pool_cap() - ws.slots_used()
    for name, root in items:
        if (Path(root) / "job" / "fleet-off").exists() and not status:
            continue  # a switched-off project starts nothing
        paused = {str(x)[:3] for x in ws.read_json(Path(root) / "job" / "router-state.json").get("paused", []) or []}
        for t in tickets(root):
            if t["num"] in paused and not status:
                continue
            st = state_of(t, running)
            if st == 'waiting for a slot' and limit_hit(root, t['num']):
                continue
            if status:
                print(name, t["num"], st)
                continue
            if st == "needs you" and t["phase"] == "waiting-user" and free > 0 and resume_with_answer(root, t, dry):
                free -= 1  # the owner answered on the dashboard: the planner continues with the answer
                continue
            if st != "waiting for a slot" or free <= 0:
                continue
            print(name + ": starting the writer of " + t["slug"])
            free -= 1
            if dry:
                continue
            log = open(Path(root) / "job" / ("plan-" + t["num"] + ".out"), "a", encoding="utf-8")
            flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0
            subprocess.Popen(["node", ".claude/scripts/plan.cjs", t["slug"], str(t["brief"].relative_to(root)).replace("\\", "/")], cwd=root, stdout=log, stderr=log,
                             stdin=subprocess.DEVNULL, creationflags=flags)
    return 0


if __name__ == "__main__":
    sys.exit(main())
