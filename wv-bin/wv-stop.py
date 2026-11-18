#!/usr/bin/env python3
"""wv-stop.py [--dry] [<fleet-root> ...]     (no root: every registered project)

Stopping or pausing the fleet must leave nothing of it running. The router loop is stopped by the dashboard; this stops
everything the loop's agents started and that outlives them:
  1. worker, tester, reviewer, merger... OpenCode sessions of the project (deleted, which aborts them);
  2. every process whose command line points into the project's folder or one of its worktrees (<root>-NNN-slug,
     .claude/worktrees): test runners, builds, dev servers (next, ng serve), esbuild, vitest, pnpm/npm, bash wrappers;
  3. orphaned Playwright / agent-browser headless Chrome (a browser check whose agent died keeps its renderer, often
     gigabytes and a whole core), plus the router loop and its wake watcher.
Never touched: the dashboard server, the Workov app, the OpenCode background service, and this process and its parents.
Prints one line per thing stopped."""
import json
import os
import re
import sqlite3
import shutil
import subprocess
import sys
import time
from pathlib import Path

AGENTS = ("worker", "teammate", "implementer", "tester", "reviewer", "merger", "checker", "reproducer", "designer", "planner", "watchdog")
KEEP = ("shell-snapshots", "dashboard-server.py", "workov.exe", "opencode.exe\" serve", "wv-stop.py")
BROWSER = re.compile(r"chrome-headless-shell|ms-playwright|agent-browser", re.I)


def norm(p):
    return str(p).replace("\\", "/").rstrip("/").lower()


def roots(args):
    if args:
        return [norm(a) for a in args]
    try:
        data = json.loads((Path.home() / ".workov" / "fleets.json").read_text(encoding="utf-8"))
    except Exception:
        data = []
    return [norm(f.get("root", "")) for f in data if isinstance(f, dict) and f.get("root")]


def procs():
    if os.name != "nt":
        out = subprocess.run(["ps", "-eo", "pid,ppid,comm,args"], capture_output=True, text=True).stdout.splitlines()[1:]
        res = []
        for ln in out:
            parts = ln.split(None, 3)
            if len(parts) == 4:
                res.append({"ProcessId": int(parts[0]), "ParentProcessId": int(parts[1]), "Name": parts[2], "CommandLine": parts[3]})
        return res
    cmd = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=60).stdout
    try:
        data = json.loads(out)
    except Exception:
        return []
    return data if isinstance(data, list) else [data]


def kill(pid):
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=30)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def neutral_sessions(rs):
    """the router runs workers from a neutral folder: attribute those sessions to a project by their ticket (wv-sessions.py)"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("wv_sessions", Path(__file__).resolve().parent / "wv-sessions.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return [x for x in mod.live() if any(norm(x["root"]) == r or norm(x["root"]).startswith(r) for r in rs)]


def stop_sessions(rs, dry):
    db = os.environ.get("OPENCODE_DB") or str(Path.home() / ".local" / "share" / "opencode" / "opencode.db")
    n = 0
    try:
        con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=5)
        now = time.time() * 1000
        marks = ",".join("?" * len(AGENTS))
        for sid, title, d, upd in con.execute(
            "SELECT id, title, directory, time_updated FROM session_v2 WHERE agent IN (" + marks + ") AND time_archived IS NULL", AGENTS
        ):
            if now - (upd or 0) > 30 * 60 * 1000 or not any(norm(d or "").startswith(r) for r in rs):
                continue
            print("session " + (title or sid))
            n += 1
            if not dry:
                subprocess.run([shutil.which("opencode") or "opencode", "session", "delete", sid], capture_output=True, timeout=60)
    except Exception:
        pass
    try:
        for x in neutral_sessions(rs):
            print("session " + x["title"])
            n += 1
            if not dry:
                subprocess.run([shutil.which("opencode") or "opencode", "session", "delete", x["id"]], capture_output=True, timeout=60)
    except Exception:
        pass
    return n


def salvage_worktrees(rs, dry):
    """Uncommitted work in a ticket worktree is saved as a patch (tracked changes plus untracked files) before anything is stopped, so a
    stop, a reap or an agent's mistake can never be the only place that work lived: ~/.workov/history/<project>/."""
    from datetime import datetime
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    seen = set()
    for r in rs:
        try:
            out = subprocess.run(["git", "-C", r, "worktree", "list", "--porcelain"], capture_output=True, text=True, timeout=30).stdout
        except Exception:
            continue
        for ln in out.splitlines():
            if not ln.startswith("worktree "):
                continue
            wt = ln[9:].strip()
            if norm(wt) in seen or norm(wt) == r:
                continue
            seen.add(norm(wt))
            try:
                if not dry:  # intent-to-add writes the worktree's index: a dry run only looks
                    subprocess.run(["git", "-C", wt, "add", "-N", "."], capture_output=True, timeout=60)
                diff = subprocess.run(["git", "-C", wt, "-c", "core.safecrlf=false", "diff", "--ignore-cr-at-eol"], capture_output=True, text=True, timeout=120).stdout
            except Exception:
                continue
            if dry and not diff.strip():
                diff = subprocess.run(["git", "-C", wt, "ls-files", "--others", "--exclude-standard"], capture_output=True, text=True, timeout=60).stdout
            if not diff.strip():
                continue
            dest = Path.home() / ".workov" / "history" / Path(r).name / (Path(wt).name + "-" + stamp + ".patch")
            print(("would save worktree changes: " if dry else "worktree changes saved: ") + str(dest))
            if not dry:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(diff, encoding="utf-8")


def stop_routers(dry):
    """The one router keeps its sessions in OpenCode's database: a stop must end them too, or the next start resumes an old router
    that still believes yesterday's dispatches (it relaunches workers). Deletes every router session of the neutral folder."""
    db = os.environ.get("OPENCODE_DB") or str(Path.home() / ".local" / "share" / "opencode" / "opencode.db")
    neutral = norm(Path.home() / "Workov" / "router")
    n = 0
    try:
        con = sqlite3.connect("file:" + db.replace("\\", "/") + "?mode=ro", uri=True, timeout=5)
        for sid, title, d in con.execute("SELECT id, title, directory FROM session_v2 WHERE agent = 'router' AND parent_id IS NULL AND time_archived IS NULL"):
            if norm(d or "").startswith(neutral):
                print("router session " + (title or sid))
                n += 1
                if not dry:
                    subprocess.run([shutil.which("opencode") or "opencode", "session", "delete", sid], capture_output=True, timeout=60)
    except Exception:
        pass
    return n


def archive_logs(rs, dry):
    """the router log of a stopped run is history: move it to job/logs/ so the next start writes a fresh one"""
    from datetime import datetime
    for r in rs:
        f = Path(r) / "job" / "router-loop.log"
        try:
            if f.is_file() and f.stat().st_size:
                dest = f.parent / "logs" / ("router-loop-" + datetime.now().strftime("%Y%m%dT%H%M%S") + ".log")
                print(("would archive log to " if dry else "log archived to ") + str(dest))
                if not dry:
                    dest.parent.mkdir(exist_ok=True)
                    f.replace(dest)
        except OSError:
            pass


def main():
    dry = "--dry" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--dry"]
    rs = roots(args)
    if not rs:
        return 0
    plist = procs()
    by = {p["ProcessId"]: p for p in plist}
    me = set()
    pid = os.getpid()
    while pid in by and pid not in me:
        me.add(pid)
        pid = by[pid]["ParentProcessId"]
    me.add(os.getpid())
    salvage_worktrees(rs, dry)
    n = stop_sessions(rs, dry)
    if not args:
        n += stop_routers(dry)
    hit = {}
    for p in plist:
        cl = norm(p.get("CommandLine") or "")
        if p["ProcessId"] in me or not cl or any(k in cl or k in (p.get("Name") or "").lower() for k in KEEP):
            continue
        in_project = any(r in cl or (r + "-") in cl or (r + "/.claude/worktrees") in cl for r in rs)
        loop = re.search(r"\.claude/scripts/router-(loop|wake)\.sh\s*$|router-wake .* arm ", cl) is not None and " -c " not in cl
        orphan_browser = bool(BROWSER.search(p.get("CommandLine") or "")) and (p["ParentProcessId"] not in by or BROWSER.search(by[p["ParentProcessId"]].get("CommandLine") or "") is None) and not args
        if in_project or loop or orphan_browser:
            hit[p["ProcessId"]] = p
    # a child dies with its parent: only kill the roots of each group
    for pid, p in sorted(hit.items()):
        if p["ParentProcessId"] in hit:
            continue
        print(("would stop " if dry else "stopped ") + str(pid) + " " + str(p.get("Name")) + " " + (p.get("CommandLine") or "")[:100])
        n += 1
        if not dry:
            kill(pid)
    if not args:
        archive_logs(rs, dry)
    if not n:
        print("nothing of the fleet was running")
    return 0


if __name__ == "__main__":
    sys.exit(main())
