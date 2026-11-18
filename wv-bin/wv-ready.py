#!/usr/bin/env python3
"""wv-ready.py <fleet-root>

Prints, for the router's cycle prompt, the tickets of this project that MUST be dispatched now: `ready` on the board, not paused,
every `waits for NNN` dependency `done`, no live worker, and a free worker slot (the hub's concurrency.maxParallelWorkers minus the
workers live on the computer). The router (a small model) reads a 80 KB rulebook and often wanders for many minutes without
dispatching; this hands it the decision, computed deterministically, as its first and only job for the cycle. Prints nothing when
there is nothing to dispatch."""
import importlib.util
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location("wv_sessions", HERE / "wv-sessions.py")
ws = importlib.util.module_from_spec(_s)
_s.loader.exec_module(ws)


def main():
    root = sys.argv[1]
    base = Path(root)
    try:
        board = (base / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        return 0
    status = ws.board_status(root)
    paused = {str(x)[:3] for x in ws.read_json(base / "job" / "router-state.json").get("paused", []) or []}
    cap = ws.pool_cap()
    live = ws.live()
    free = cap - ws.slots_used()
    busy = {s["ticket"] for s in live if ws.norm(s["root"]) == ws.norm(root)}
    ledger = ws.read_json(base / "job" / "router-state.json").get("dispatched", []) or []
    out = []
    for m in re.finditer(r"^\|\s*(\d{3})\s*\|[^|]*\|\s*([a-z-]+)\s*\|[^|]*\|\s*([^|]*)\|", board, re.M):
        num, st, runs = m.group(1), m.group(2), m.group(3)
        if num in paused or num in busy:
            continue
        if st == "in-progress":
            # an in-progress ticket whose worker is gone (killed, crashed) and whose ledger phase is still `building` for over
            # 3 minutes is an orphan: dispatch it again (a retry is not consumed by a worker that was cancelled)
            ent = next((e for e in ledger if isinstance(e, dict) and str(e.get("ticket", "")).startswith(num)), None)
            try:
                age = time.time() - datetime.strptime(str(ent.get("lastPhaseAt", ""))[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
            except Exception:
                age = 0
            if ent is not None and not (str(ent.get("lastPhase")) == "building" and age > 180):
                continue
        elif st != "ready":
            continue
        deps = re.findall(r"\b(\d{3})\b", runs) if runs.strip().lower().startswith(("waits for", "after")) else []
        if any(status.get(d) != "done" for d in deps):
            continue
        if free <= 0:
            break
        free -= 1
        slug = next((d.name for d in sorted((base / "specs" / "tickets").glob(num + "-*"))), num)
        out.append(slug)
    if out:
        print(" DISPATCH THESE NOW (decided by the fleet, not up for reconsideration; the first thing you do this cycle is spawn the worker for each, then record it in the ledger and set the board row to in-progress): " + ", ".join(out) + ".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
