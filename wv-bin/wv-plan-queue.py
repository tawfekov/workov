#!/usr/bin/env python3
"""wv-plan-queue.py   plan the tickets of ~/Workov/plan-queue.json one at a time, each when an agent slot is free.

The queue is a JSON list of {"root": <fleet folder>, "ticket": "NNN-slug", "brief": "job/briefs/NNN.md"}. A writer (plan.cjs) takes an
agent slot like a worker, so this waits until the hub's slots (wv-sessions.py: pool_cap - slots_used) leave room, runs plan.cjs for the
next ticket, waits for it to end, and goes on. A ticket whose planner ends `waiting-user` stays for the owner's answer (the dashboard
shows its questions) and the queue moves on. Finished entries are written to plan-queue.done.json. Safe to start twice: a lock file
keeps one queue."""
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
HERE = Path(__file__).resolve().parent
QUEUE = HOME / "Workov" / "plan-queue.json"
DONE = HOME / "Workov" / "plan-queue.done.json"
LOCK = HOME / "Workov" / "plan-queue.lock"

_spec = importlib.util.spec_from_file_location("wv_sessions", HERE / "wv-sessions.py")
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)


def load(p, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def alive(pid):
    try:
        out = subprocess.run(["tasklist", "/FI", "PID eq " + str(pid)], capture_output=True, text=True, timeout=20).stdout
        return str(pid) in out
    except Exception:
        return False


def main():
    if LOCK.is_file():
        try:
            if alive(int(LOCK.read_text().strip())):
                print("a plan queue already runs")
                return 0
        except ValueError:
            pass
    LOCK.write_text(str(os.getpid()))
    try:
        while True:
            queue = load(QUEUE, [])
            done = load(DONE, [])
            seen = {(d["root"], d["ticket"]) for d in done}
            todo = [q for q in queue if (q["root"], q["ticket"]) not in seen]
            if not todo:
                print("plan queue empty")
                return 0
            q = todo[0]
            try:
                free = ss.pool_cap() - ss.slots_used()
            except Exception:
                free = 0
            if free < 1:
                time.sleep(60)
                continue
            beat = Path(q["root"]) / "job" / ("status-writer-" + q["ticket"][:3] + ".json")
            print("planning", q["ticket"], flush=True)
            r = subprocess.run(["node", ".claude/scripts/plan.cjs", q["ticket"], q["brief"]], cwd=q["root"],
                               capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            state = load(beat, {}).get("phase", "")
            done.append({"root": q["root"], "ticket": q["ticket"], "exit": r.returncode, "phase": state, "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
            DONE.write_text(json.dumps(done, indent=1), encoding="utf-8")
            time.sleep(5)
    finally:
        try:
            LOCK.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
