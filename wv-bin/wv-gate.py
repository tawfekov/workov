#!/usr/bin/env python3
"""wv-gate.py [--dry] [<ticket-number>]

Nothing is skipped without the owner's say. A worker that cannot run a check (no test account, credential or tool) must block
the ticket with a question; agents sometimes record SKIP and finish instead. This gate runs before every router turn (and
the router runs it again before it lands a ticket) over every registered project. For a ticket that is `in-progress` or
`in-review` and has a results.json with a check marked SKIP that the owner never answered (no user-decision.md in the ticket
folder mentions the check's id), it
  - sets the board row to `blocked`, so the ticket cannot be landed,
  - drops the finished worker from the ledger and records the ticket in pendingDecisions,
  - appends the question (skip it, or provide what it needs) to the ticket's rd.md, which the dashboard shows,
  - marks the worker heartbeat `blocked` with the question as its note.
The owner's answer then goes through wv-settle.py, which starts a fresh worker that has the answer.
Exit 1 and a line per ticket when something was blocked, 0 when every ticket may proceed."""
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("wv_settle", HERE / "wv-settle.py")
st = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(st)
ws = st.ws


def skipped(tdir):
    res = ws.read_json(tdir / "results.json")
    return [c for c in res.get("checks", []) or [] if isinstance(c, dict) and str(c.get("status", "")).upper().startswith("SKIP")]


def answered(tdir, cid):
    d = tdir / "user-decision.md"
    return d.is_file() and re.search(re.escape(cid), d.read_text(encoding="utf-8", errors="replace"), re.I) is not None


def gate(name, root, only, dry):
    base = Path(root)
    board = ws.board_status(root)
    blocked = []
    for tdir in sorted((base / "specs" / "tickets").glob("[0-9][0-9][0-9]-*")):
        num = tdir.name[:3]
        if (only and num != only) or board.get(num) not in ("in-progress", "in-review"):
            continue
        open_skips = [c for c in skipped(tdir) if not answered(tdir, str(c.get("id", "")))]
        if not open_skips:
            continue
        ids = ", ".join(str(c.get("id")) for c in open_skips)
        print(name + ": ticket " + tdir.name + " skipped " + ids + " without asking; blocked with a question")
        blocked.append(tdir.name)
        if dry:
            continue
        q = ("\n## Open questions (raised by the fleet gate)\nA check was skipped without your approval: " + ids + ". "
             "Answer with the check id and one of:\n- A: I provide what it needs (name the environment variable or account), the worker runs it.\n"
             "- B: skip " + ids + " (say so with the id).\n")
        rd = tdir / "rd.md"
        if rd.is_file() and "raised by the fleet gate" not in rd.read_text(encoding="utf-8", errors="replace"):
            st.write_atomic(rd, rd.read_text(encoding="utf-8", errors="replace").rstrip() + "\n" + q)
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
            beat.update({"phase": "blocked", "note": "Question: " + ids + " was skipped; provide what it needs or approve the skip", "updatedAt": state["updatedAt"]})
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
