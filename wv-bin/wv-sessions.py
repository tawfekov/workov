#!/usr/bin/env python3
"""wv-sessions.py live [<fleet-root>]   list live worker sessions (exit 0 when there is one)
wv-sessions.py reap [--dry]            stop worker sessions that must not be running

One fleet, one worker at a time. A worker is an OpenCode session (agent worker/teammate/implementer) that wrote to its
session within the last 5 minutes; its ticket is the 3-digit number in the session title. The fleet it belongs to is the
registered project (~/.workov/fleets.json) whose folder contains the session's directory (worktrees included).

`reap` deletes (which aborts) every live worker session that is
  - for a ticket whose board row is not `in-progress` (failed, done, draft, ready, blocked, in-review...), or
  - an older duplicate of another live session for the same ticket, or
  - not the only worker on the computer: when workers of several tickets are live, only the newest one is kept.
The router marks a ticket failed on the board and in its ledger but never stops the session; this is the reaper."""
import json
import os
import re
import sqlite3
import shutil
import subprocess
import sys
import time
from pathlib import Path

LIVE_SECONDS = 300
AGENTS = ("worker", "teammate", "implementer")


def norm(p):
    return str(p).replace("\\", "/").rstrip("/").lower()


def read_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return {}


def fleets():
    data = read_json(Path.home() / ".workov" / "fleets.json")
    return [(str(f.get("name", "")), str(f.get("root", ""))) for f in (data if isinstance(data, list) else []) if isinstance(f, dict) and f.get("root")]


def board_status(root):
    try:
        text = (Path(root) / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        return {}
    return {m.group(1): m.group(2) for m in re.finditer(r"^\|\s*(\d{3})\s*\|[^|]*\|\s*([a-z-]+)\s*\|", text, re.M)}


def sessions():
    db = os.environ.get("OPENCODE_DB") or str(Path.home() / ".local" / "share" / "opencode" / "opencode.db")
    out = []
    try:
        con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=5)
        now = time.time() * 1000
        marks = ",".join("?" * len(AGENTS))
        for sid, title, d, created, updated, parent in con.execute(
            "SELECT id, title, directory, time_created, time_updated, parent_id FROM session_v2 "
            "WHERE agent IN (" + marks + ") AND time_archived IS NULL ORDER BY time_updated DESC", AGENTS
        ):
            if now - (updated or 0) > LIVE_SECONDS * 1000:
                continue
            m = re.search(r"\b(\d{3})\b", title or "")
            out.append({"id": sid, "title": title or "", "dir": norm(d or ""), "created": created or 0, "ticket": m.group(1) if m else "", "parent": parent or "", "updated": updated or 0})
    except Exception:
        pass
    return out


def pool_cap():
    """the one agent limit: concurrency.maxParallelWorkers of the hub (default 4). Planning, designing, building and review all share it."""
    hub = read_json(Path.home() / ".workov" / "hub.json").get("root", "")
    try:
        return max(1, min(12, int(read_json(Path(hub) / "specs" / "workov.config.json").get("concurrency", {}).get("maxParallelWorkers") or 4)))
    except (TypeError, ValueError):
        return 4


def helper_jobs():
    """ticket writers, designers and reviewers running now (plan.cjs / mockup.cjs / review.cjs): they take a slot like a worker"""
    if os.name != "nt":
        return set()
    cmd = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '(plan|mockup|review)\\.cjs' } | Select-Object CommandLine | ConvertTo-Json -Compress"
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=60).stdout
        d = json.loads(out) if out.strip() else []
    except Exception:
        return set()
    jobs = set()
    for p in (d if isinstance(d, list) else [d]):
        m = re.search(r"(plan|mockup|review)\.cjs\s+(\d{3})", (p.get("CommandLine") or "").replace("\\", "/"))
        if m:
            jobs.add((m.group(1), m.group(2)))
    return jobs


def slots_used():
    """slots taken right now: live workers + running writers, designers and reviewers"""
    return len({(s["root"], s["ticket"]) for s in live()}) + len(helper_jobs())


NEUTRAL = norm(Path.home() / "Workov" / "router")


def fleet_of(s, items):
    # the one router runs its subagents (workers included) from a neutral folder that belongs to no project: attribute
    # such a session by its ticket number, to the only project whose board has that ticket (else the project the router serves now)
    if s["dir"].startswith(NEUTRAL) and s["ticket"]:
        have = [(n, r) for n, r in items if s["ticket"] in board_status(r)]
        if len(have) == 1:
            return have[0]
        cur = read_json(Path.home() / ".workov" / "router-project.json")
        for n, r in have:
            if norm(r) == norm(cur.get("root", "")):
                return (n, r)
        return None
    best = None
    for name, root in items:
        r = norm(root)
        if s["dir"] == r or s["dir"].startswith(r):
            if best is None or len(r) > len(norm(best[1])):
                best = (name, root)
    return best


_PROCS = {"at": 0.0, "val": None}
DEAD_AFTER = 45  # seconds without a write from a dispatcher-launched worker whose process is gone: it is dead, not "live for five minutes"


def worker_procs():
    """{(normalised project root, ticket)} of every `opencode run` worker the dispatcher started (its prompt names the ticket and the
    project folder); None when processes cannot be listed. Cached for 5 s."""
    if os.name != "nt":
        return None
    if _PROCS["val"] is not None and time.time() - _PROCS["at"] < 5:
        return _PROCS["val"]
    cmd = "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Select-Object CommandLine | ConvertTo-Json -Compress"
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=60).stdout
        d = json.loads(out) if out.strip() else []
    except Exception:
        return None
    found = set()
    for p in (d if isinstance(d, list) else [d]):
        m = re.search(r"Build ticket (\d{3}) solo\. Project folder \(work only inside it\): (.+?)\. Ticket folder path", (p.get("CommandLine") or ""))
        if m:
            found.add((norm(m.group(2)), m.group(1)))
    _PROCS["at"], _PROCS["val"] = time.time(), found
    return found


def live(root=None):
    """live worker sessions, each with its fleet; limited to one fleet root when given. A worker the dispatcher started
    ("Worker for ticket NNN ...", no parent session) is live only while its `opencode run` process exists or it wrote within
    DEAD_AFTER seconds: a crashed one (provider limit, port clash) stops counting at once and can be started again."""
    items = fleets()
    procs = worker_procs()
    now = time.time() * 1000
    res = []
    for s in sessions():
        f = fleet_of(s, items)
        if not f or (root is not None and norm(f[1]) != norm(root)):
            continue
        if procs is not None and not s.get("parent") and s["title"].startswith("Worker for ticket ") and s["ticket"]:
            if (norm(f[1]), s["ticket"]) not in procs and now - (s.get("updated") or 0) > DEAD_AFTER * 1000:
                continue
        res.append(dict(s, fleet=f[0], root=f[1]))
    # wv-proc-live: a worker process that is running IS live, however quiet its session is (a long test run or a slow model writes nothing
    # for minutes, and the session list drops it after LIVE_SECONDS: the ticket then looks workerless and a second worker is started)
    if procs:
        have = {(norm(x["root"]), x["ticket"]) for x in res}
        for (nroot, ticket) in procs:
            if (nroot, ticket) in have or (root is not None and nroot != norm(root)):
                continue
            f = next((f for f in items if norm(f[1]) == nroot), None)
            if f:
                res.append({"id": "proc:" + ticket, "title": "Worker for ticket " + ticket, "dir": nroot, "created": now, "ticket": ticket,
                            "parent": "", "updated": now, "fleet": f[0], "root": f[1]})
    return res


def doomed():
    items = fleets()
    ls = live()
    boards = {norm(r): board_status(r) for _, r in items}
    bad = {}
    for s in ls:
        st = boards.get(norm(s["root"]), {}).get(s["ticket"], "")
        fresh = (time.time() * 1000 - s["created"]) < 15 * 60 * 1000
        # a worker the router has just dispatched is still on a `ready` row until the router flips it to in-progress
        if st != "in-progress" and not (st == "ready" and fresh):
            bad[s["id"]] = "board row is '" + (st or "unknown") + "', not in-progress"
    keep = [s for s in ls if s["id"] not in bad]
    # a worker session that started another (the dispatcher and the worker it runs) is ONE worker: only the innermost counts
    parents = {s["parent"] for s in ls if s["parent"]}
    keep = [s for s in keep if s["id"] not in parents]
    seen = {}
    for s in sorted(keep, key=lambda x: -x["created"]):
        k = (norm(s["root"]), s["ticket"])
        if k in seen:
            bad[s["id"]] = "older duplicate of a live worker for the same ticket"
        else:
            seen[k] = s
    keep = [s for s in keep if s["id"] not in bad]
    # the computer runs as many workers at once as the hub allows (concurrency.maxParallelWorkers); the newest ones stay
    hub = read_json(Path.home() / ".workov" / "hub.json").get("root", "")
    try:
        cap = max(1, int(read_json(Path(hub) / "specs" / "workov.config.json").get("concurrency", {}).get("maxParallelWorkers") or 1))
    except (TypeError, ValueError):
        cap = 1
    for s in sorted(keep, key=lambda x: -x["created"])[cap:]:
        bad[s["id"]] = "more workers are live than the " + str(cap) + " the fleet allows"
    return ls, bad


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "live"
    if cmd == "live":
        ls = live(sys.argv[2] if len(sys.argv) > 2 else None)
        for s in ls:
            print(s["fleet"], s["ticket"], s["id"], s["title"], sep="\t")
        return 0 if ls else 1
    if cmd == "reap":
        dry = "--dry" in sys.argv
        ls, bad = doomed()
        for s in ls:
            if s["id"] in bad:
                print(("would stop " if dry else "stopping ") + s["fleet"] + " " + s["ticket"] + " " + s["id"] + ": " + bad[s["id"]])
                if not dry:
                    try:
                        subprocess.run([shutil.which("opencode") or "opencode", "session", "delete", s["id"]], capture_output=True, timeout=60)
                    except Exception as e:
                        print("  could not stop: " + str(e))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
