#!/usr/bin/env python3
"""wv-gate.py [--dry] [<ticket-number>]

Nothing is skipped without the owner's say. A worker that cannot run a check (no test account, credential or tool) must block
the ticket with a question; agents sometimes record SKIP and finish instead. This gate runs before every router turn (and
the router runs it again before it lands a ticket) over every registered project. For a ticket that is `in-progress` or
`in-review` and has a results.json (in the project or in the ticket's worktree) with a check that is SKIP, FAIL, or PASS without its
evidence file, which the owner never answered (no user-decision.md in the ticket folder mentions the check's id), it
  - sets the board row to `blocked`, so the ticket cannot be landed,
  - drops the finished worker from the ledger and records the ticket in pendingDecisions,
  - appends the question (skip it, or provide what it needs) to the ticket's rd.md, which the dashboard shows,
  - marks the worker heartbeat `blocked` with the question as its note.
The owner's answer then goes through wv-settle.py, which starts a fresh worker that has the answer.
Exit 1 and a line per ticket when something was blocked, 0 when every ticket may proceed."""
import importlib.util
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("wv_settle", HERE / "wv-settle.py")
st = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(st)
ws = st.ws


def ticket_dirs(base, num):
    """The ticket's folder in the project and in its worktrees: a worker writes results.json and evidence/ in its own worktree."""
    out = sorted((base / "specs" / "tickets").glob(num + "-*"))
    try:
        r = subprocess.run(["git", "-C", str(base), "worktree", "list", "--porcelain"], capture_output=True, text=True, timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for block in (r.stdout or "").split("\n\n"):
            path = re.search(r"^worktree (.+)$", block, re.M)
            branch = re.search(r"^branch refs/heads/(.+)$", block, re.M)
            if not path or not branch or not re.search(r"(^|/)" + num + "-", branch.group(1)):
                continue
            wt = Path(path.group(1))
            if wt.resolve() != base.resolve():
                out += sorted((wt / "specs" / "tickets").glob(num + "-*"))
    except Exception:
        pass
    return out


def problems(dirs, decision=None):
    """Checks that cannot be accepted: SKIP, FAIL, or PASS with an evidence file that does not exist. [(check, kind)], one per id.
    Results older than the owner's latest answer are stale (a fresh worker has not finished yet), so they are not judged again."""
    seen, out = set(), []
    for d in dirs:
        res = d / "results.json"
        if decision is not None and decision.is_file() and res.is_file() and res.stat().st_mtime < decision.stat().st_mtime:
            continue
        for c in ws.read_json(res).get("checks", []) or []:
            if not isinstance(c, dict) or str(c.get("id", "")) in seen:
                continue
            st = str(c.get("status", "")).upper()
            kind = "skip" if st.startswith("SKIP") else "fail" if st.startswith("FAIL") else None
            ev = str(c.get("evidence") or "").strip()
            if kind is None and st.startswith("PASS") and ev and not any(any(x.glob(ev)) for x in dirs if x.is_dir()):
                kind = "evidence"
            if kind:
                seen.add(str(c.get("id", "")))
                out.append((c, kind))
    return out


def finished_after(dirs, base, num, when):
    """True when a worker of this ticket reported phase done (its heartbeat in the project or its worktree) after `when` (epoch seconds)."""
    roots = [base] + [d.parents[2] for d in dirs if len(d.parents) > 2]
    for r in roots:
        beat = ws.read_json(Path(r) / "job" / "status.json")
        if not str(beat.get("ticket", "")).startswith(num) or str(beat.get("phase", "")).lower() != "done":
            continue
        try:
            at = datetime.strptime(str(beat.get("updatedAt", "")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
        if at > when:
            return True
    return False


def answered(tdir, cid):
    """The owner accepted this check: the answer names it and does not ask for a real run. An answer of "A: run it for real" is not an
    acceptance, so a check that is still SKIP or FAIL after that answer is asked about again."""
    d = tdir / "user-decision.md"
    if not d.is_file():
        return False
    text = d.read_text(encoding="utf-8", errors="replace")
    if re.search(re.escape(cid), text, re.I) is None:
        return False
    wants_run = re.search(r"(^|\W)A\s*[:.)-]|run (them |it |these )?(for real|really)|\bfix (it|them)\b", text, re.I) is not None
    accepts = re.search(r"(^|\W)B\s*[:.)-]|\bskip\b|\baccept\b|\bas it is\b", text, re.I) is not None
    return accepts or not wants_run


def live_workers():
    """{(project name, ticket number)} with a live worker process (wv-sessions.py live): the gate never judges a ticket while its worker still works."""
    out = set()
    try:
        r = subprocess.run([sys.executable, "-I", str(HERE / "wv-sessions.py"), "live"], capture_output=True, text=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for ln in (r.stdout or "").splitlines():
            p = ln.split("	")
            if len(p) >= 2:
                out.add((p[0].strip(), p[1].strip()))
    except Exception:
        pass
    return out


def gate(name, root, only, dry):
    base = Path(root)
    live = live_workers()
    board = ws.board_status(root)
    blocked = []
    for tdir in sorted((base / "specs" / "tickets").glob("[0-9][0-9][0-9]-*")):
        num = tdir.name[:3]
        if (only and num != only) or board.get(num) not in ("in-progress", "in-review") or (name, num) in live:
            continue
        dirs = [tdir] + [x for x in ticket_dirs(base, num) if x != tdir]
        dec = tdir / "user-decision.md"
        if dec.is_file() and finished_after(dirs, base, num, dec.stat().st_mtime):
            dec = None  # a worker finished after the answer: its results are final, not stale
        open_ = [(c, k) for c, k in problems(dirs, dec) if not answered(tdir, str(c.get("id", "")))]
        if not open_:
            continue
        ids = ", ".join(str(c.get("id")) for c, _ in open_)
        what = {"skip": "skipped", "fail": "failed", "evidence": "has no evidence file"}
        parts = sorted({what[k] for _, k in open_})
        print(name + ": ticket " + tdir.name + " check(s) " + ids + " " + " / ".join(parts) + "; blocked with a question")
        blocked.append(tdir.name)
        if dry:
            continue
        q = ("\n## Open questions (raised by the fleet gate)\nA check cannot be accepted: " + ids + " (" + ", ".join(parts) + "). "
             "A skipped check was never run, a failed one does not pass, and a PASS needs its evidence file (a screenshot or output) in the ticket's evidence folder.\n"
             "Answer with the check id and one of:\n- A: the worker fixes it, runs the check for real and saves the evidence (for a skip: I provide what it needs, name the environment variable or account).\n"
             "- B: accept " + ids + " as it is (say so with the id).\n")
        rd = tdir / "rd.md"
        if rd.is_file():
            body = rd.read_text(encoding="utf-8", errors="replace")
            body = re.sub(r"\n## Open questions \(raised by the fleet gate\).*?(?=\n## |\Z)", "", body, flags=re.S)  # the newest question replaces the old one
            st.write_atomic(rd, body.rstrip() + "\n" + q)
        st.set_board(root, num, "blocked")
        sp = base / "job" / "router-state.json"
        state = ws.read_json(sp)
        state["dispatched"] = [e for e in state.get("dispatched", []) or [] if not (isinstance(e, dict) and str(e.get("ticket", "")).startswith(num))]
        pend = [x for x in state.get("pendingDecisions", []) or [] if x != tdir.name]
        state["pendingDecisions"] = pend + [tdir.name]
        state["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        st.write_atomic(sp, json.dumps(state, indent=2) + "\n")
        hb = base / "job" / "status.json"
        beat = ws.read_json(hb)
        if str(beat.get("ticket", "")).startswith(num):
            beat.update({"phase": "blocked", "note": "Question: " + ids + " (" + ", ".join(parts) + "); fix it and run it for real, or approve it as it is", "updatedAt": state["updatedAt"]})
            st.write_atomic(hb, json.dumps(beat, indent=2) + "\n")
    return blocked


def main():
    args = [a for a in sys.argv[1:] if a != "--dry"]
    only = args[0] if args else None
    hit = []
    for name, root in ws.fleets():
        try:
            hit += gate(name, root, only, "--dry" in sys.argv)
        except Exception as e:
            print(name + ": gate failed: " + str(e))
    return 1 if hit else 0


if __name__ == "__main__":
    sys.exit(main())
