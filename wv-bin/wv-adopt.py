#!/usr/bin/env python3
"""wv-adopt.py [--dry]

The router starts a worker and writes the board row (`in-progress`) and the ledger entry some minutes later, or never. Meanwhile the
board says `ready` while a worker is already building the ticket, which is what you see as "004 is ready but running". This makes
the state true: for every live worker session (wv-sessions.py) whose ticket is `ready` on its project's board, the board row and
rd.md become `in-progress` and the ledger gets a `dispatched` entry (attempt 1, phase building), so the router, the dashboard, the
turn picker and the reaper all agree. A paused ticket is never adopted."""
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location("wv_settle", HERE / "wv-settle.py")
st = importlib.util.module_from_spec(_s)
_s.loader.exec_module(st)
ws = st.ws


def main():
    dry = "--dry" in sys.argv
    seen = set()
    for s in ws.live():
        key = (s["root"], s["ticket"])
        if key in seen:
            continue
        seen.add(key)
        root, num = s["root"], s["ticket"]
        if ws.board_status(root).get(num) != "ready":
            continue
        base = Path(root)
        sp = base / "job" / "router-state.json"
        state = ws.read_json(sp)
        if num in {str(x)[:3] for x in state.get("paused", []) or []}:
            continue
        slug = next((d.name for d in sorted((base / "specs" / "tickets").glob(num + "-*"))), num)
        print(s["fleet"] + ": " + slug + " has a live worker but is `ready`: marking it in-progress")
        if dry:
            continue
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        disp = [e for e in state.get("dispatched", []) or [] if isinstance(e, dict)]
        if not any(str(e.get("ticket", "")).startswith(num) for e in disp):
            disp.append({"ticket": slug, "agentId": "", "port": 3101 + len(disp), "account": "t001", "attempt": 1, "retriesUsed": 0, "maxRetries": 2,
                         "budget": {"usd": 3.0, "turns": 300, "turnsUsed": 0, "estCostUsd": 0.0}, "lastPhase": "building", "lastPhaseAt": now,
                         "branch": "feat/" + slug, "lastDeath": None})
        state["dispatched"] = disp
        state.setdefault("budgetSince", {}).setdefault(num, now)
        state["updatedAt"] = now
        st.write_atomic(sp, json.dumps(state, indent=2) + chr(10))
        st.set_board(root, num, "in-progress")
    return 0


if __name__ == "__main__":
    sys.exit(main())
