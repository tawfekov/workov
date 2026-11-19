#!/usr/bin/env python3
"""Claude Code hook: record a worker's activity into job/hook-status.json.

Reads one hook event as JSON on stdin. Only acts when the marker
job/ticket.json (written for fleet workers) is found by walking up from the
cwd; any other session is left untouched. Always exits 0 and prints nothing
to stdout, so it can never block or alter a session. Failures are logged to
<main>/job/logs/fleet-hook.log when the marker names an existing main checkout.
"""
import json
import os
import sys
import time

try:
    import fcntl
except ImportError:  # no flock on this platform: run without the lock
    fcntl = None

MAX_SUBAGENTS = 20
MAX_ATTENTION = 300
ATTENTION_TYPES = {"permission_prompt", "idle_prompt", "agent_needs_input", "elicitation_dialog"}
EVENTS = {"SessionStart", "PreToolUse", "PostToolUse", "SubagentStop", "Stop", "Notification", "SessionEnd"}
LOCK_WAIT_SECONDS = 1.0  # longest wait for another hook process; after it the write goes ahead unlocked


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(main, msg):
    try:
        if not isinstance(main, str) or not os.path.isdir(main):
            return
        d = os.path.join(main, "job", "logs")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "fleet-hook.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (now(), " ".join(str(msg).split())))
    except Exception:
        pass


def write_atomic(path, data):
    tmp = os.path.join(os.path.dirname(path), ".hook-status.%d.tmp" % os.getpid())
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def lock_status(job_dir):
    """An exclusive flock on job/.hook-status.lock, so overlapping hook processes
    do not lose each other's update. Returns the open fd, or None when there is
    no flock, the file cannot be opened, or the lock is still held after
    LOCK_WAIT_SECONDS (a session is never blocked for longer). Closing the fd
    releases the lock."""
    if fcntl is None:
        return None
    try:
        fd = os.open(os.path.join(job_dir, ".hook-status.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError:
            if time.monotonic() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.02)


def load_status(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def find_worktree(start):
    """Walk up from start to the dir holding job/ticket.json.

    Stops after the first directory containing a .git entry, and at the root.
    """
    d = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(d, "job", "ticket.json")):
            return d
        if os.path.lexists(os.path.join(d, ".git")):
            return None
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def apply_event(st, ev, marker, event, ts):
    st["version"] = 1
    st["ticket"] = marker.get("ticket")
    st["kind"] = marker.get("kind")
    if ev.get("session_id"):
        st["sessionId"] = ev["session_id"]
    if ev.get("transcript_path"):
        st["transcriptPath"] = ev["transcript_path"]
    resets = event == "SessionStart" and ev.get("source") in (None, "", "startup")
    if resets or not st.get("startedAt"):
        st["startedAt"] = ts
    st.setdefault("lastTool", None)
    st.setdefault("lastActivityAt", None)
    st.setdefault("toolRunning", None)
    if not isinstance(st.get("subagents"), list):
        st["subagents"] = []
    st["attention"] = None
    st["attentionType"] = None

    if event == "PreToolUse":
        # A tool call started: activity now, and the dashboard knows a tool is running.
        st["toolRunning"] = ev.get("tool_name") or "tool"
        st["lastActivityAt"] = ts
    elif event != "Notification" and event != "SubagentStop":
        st["toolRunning"] = None  # the call returned, or the turn or session ended or restarted
    if event == "PostToolUse":
        st["lastTool"] = ev.get("tool_name")
        st["lastActivityAt"] = ts
    if event == "SubagentStop":
        st["subagents"].append({"type": ev.get("agent_type") or "unknown", "stoppedAt": ts})
        st["subagents"] = st["subagents"][-MAX_SUBAGENTS:]
        st["lastActivityAt"] = ts

    if event == "Stop":
        st["state"] = "idle"
    elif event == "Notification":
        st["state"] = "needs-attention"
        st["attention"] = str(ev.get("message") or "")[:MAX_ATTENTION]
        st["attentionType"] = ev.get("notification_type")
    elif event == "SessionEnd":
        st["state"] = "ended"
    else:
        st["state"] = "active"
    st["updatedAt"] = ts


def main():
    main_dir = None
    try:
        try:
            ev = json.load(sys.stdin)
        except ValueError:
            return 0
        if not isinstance(ev, dict):
            return 0
        event = ev.get("hook_event_name")
        if event not in EVENTS:
            return 0
        if event == "SubagentStop" and ev.get("agent_type") == "":
            return 0  # internal agent
        if event == "Notification" and ev.get("notification_type", None) not in ATTENTION_TYPES | {None}:
            return 0
        root = find_worktree(ev.get("cwd") or os.getcwd())
        if root is None:
            return 0
        with open(os.path.join(root, "job", "ticket.json"), encoding="utf-8") as f:
            marker = json.load(f)
        if not isinstance(marker, dict):
            return 0
        main_dir = marker.get("main")
        status_path = os.path.join(root, "job", "hook-status.json")
        lock_fd = lock_status(os.path.join(root, "job"))
        try:
            st = load_status(status_path)
            apply_event(st, ev, marker, event, now())
            write_atomic(status_path, st)
        finally:
            if lock_fd is not None:
                os.close(lock_fd)
    except Exception as e:
        log(main_dir, "fleet-hook error: %s: %s" % (type(e).__name__, e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
