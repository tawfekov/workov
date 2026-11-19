#!/usr/bin/env python3
"""wv-stage.py: the ticket stage pipeline of a project, decided in code (zero model tokens).

Stages (display):  Draft - Plan - Design - Todo - Building - Review - Deliver - Done
Real board status: draft | specifying | designing | todo (+ ready = in the worker queue) | in-progress | in-review | delivering | done
blocked / failed / budget-exceeded are not stages: they are a "Needs you" flag on the card, and `job/stage/<NNN>.json` remembers
which stage the ticket was in, so the card stays in its own column.

This file is the ONE place that writes a ticket's status (board row + rd.md header + stage file): `set_status`. Every other script
(wv-settle, wv-dispatch, wv-adopt, wv-migrate-stages), the dashboard server and the CLI go through it.

  python wv-stage.py act  <root> <NNN> <op> [json-args]   an owner action (what the dashboard buttons send)
  python wv-stage.py tick <root>                          move tickets whose work finished (planner, worker, review, deliver)
  python wv-stage.py show <root>                          per ticket: status, stage, flag, buttons

Ops: dispatch design skip_design review skip_review fix skip_findings missing(choice) note retry
Events (what finished work reports; tick() derives them from files): plan_done design_done worker_done review_result deliver_result
Side effects that start a process (designer, reviewer, PR) are hooks the caller passes in; without one the transition is still made."""
import json
import shutil
import os
import re
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

STATUSES = ("specifying", "draft", "designing", "todo", "ready", "in-progress", "in-review", "delivering", "blocked", "done", "failed", "budget-exceeded")
NEED = ("blocked", "failed", "budget-exceeded")
STAGES = ("draft", "plan", "design", "todo", "building", "review", "deliver", "done")
STAGE_NAME = {"draft": "Draft", "plan": "Plan", "design": "Design", "todo": "Todo", "building": "Building", "review": "Review", "deliver": "Deliver", "done": "Done"}
OF_STATUS = {"draft": "draft", "specifying": "plan", "designing": "design", "todo": "todo", "ready": "todo", "in-progress": "building",
             "in-review": "review", "delivering": "deliver", "done": "done"}
ENTRY_STATUS = {"plan": "specifying", "design": "designing", "todo": "todo", "building": "ready", "review": "in-review", "deliver": "delivering", "draft": "draft"}
_LOCK = threading.RLock()


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(p):
    try:
        d = json.loads(Path(p).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".wv-")
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)


# ---------------------------------------------------------------- board + files
def board_path(root):
    return Path(root) / "specs" / "tickets" / "BOARD.md"


def rows(root):
    out = []
    try:
        text = board_path(root).read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        parts = [p.strip() for p in s.split("|")[1:-1]]
        if len(parts) >= 5 and re.fullmatch(r"\d{3}", parts[0]):
            out.append({"id": parts[0], "title": parts[1], "status": parts[2].lower(), "mode": parts[3].lower(), "runs": parts[-1]})
    return out


def row(root, tid):
    return next((r for r in rows(root) if r["id"] == tid), None)


def tdir(root, tid):
    base = Path(root) / "specs" / "tickets"
    try:
        return next((d for d in sorted(base.iterdir()) if d.is_dir() and d.name.startswith(tid + "-")), None)
    except OSError:
        return None


def sf_path(root, tid):
    return Path(root) / "job" / "stage" / (tid + ".json")


def load_sf(root, tid):
    return read_json(sf_path(root, tid))


def save_sf(root, tid, sf):
    write_atomic(sf_path(root, tid), json.dumps(sf, indent=2, ensure_ascii=False) + "\n")


def stage_of(status, sf=None):
    """The column a card stands in. A needs-you status keeps the stage the ticket was in; a queued ticket that came back from
    Review or Done (a fix, a reopen) stays in Building."""
    sf = sf or {}
    status = (status or "").lower()
    if status in NEED:
        return sf.get("stage") if sf.get("stage") in STAGES else "building"
    if status == "ready":
        return "building" if sf.get("stage") == "building" and sf.get("status") == "ready" else "todo"
    return OF_STATUS.get(status, "draft")


def set_status(root, tid, status, stage=None, **extra):
    """The one write path of a ticket's status. Updates the board row, the rd.md header and job/stage/<NNN>.json."""
    with _LOCK:
        bp = board_path(root)
        text = bp.read_text(encoding="utf-8")
        new = re.sub(r"(^\|\s*" + re.escape(tid) + r"\s*\|[^|]*\|\s*)([a-z-]+)(\s*)\|",
                     lambda m: m.group(1) + status + " " * max(1, len(m.group(2)) + len(m.group(3)) - len(status)) + "|", text, count=1, flags=re.M)
        if new != text:
            write_atomic(bp, new)
        d = tdir(root, tid)
        if d and (d / "rd.md").is_file():
            rd = (d / "rd.md").read_bytes().decode("utf-8", "replace")
            head, sep, rest = rd.partition("\n## ")
            h2 = re.sub(r"^(\*\*Status:\*\*\s*)[a-z-]+", lambda m: m.group(1) + status, head, count=1, flags=re.M)
            if h2 != head:
                write_atomic(d / "rd.md", h2 + sep + rest)
        sf = load_sf(root, tid)
        old_stage = sf.get("stage")
        if stage is None:
            if status in NEED:
                stage = old_stage if old_stage in STAGES else "building"
            elif status == "ready":
                stage = "building" if old_stage == "building" and sf.get("status") in ("in-progress", "ready", "in-review", "done") else "todo"
            else:
                stage = OF_STATUS.get(status, "draft")
        keep_ask = extra.pop("keep_ask", False)
        sf.update({"status": status, "stage": stage, "at": now()})
        if not keep_ask:
            sf.pop("ask", None)
        for k, v in extra.items():
            if v is None:
                sf.pop(k, None)
            else:
                sf[k] = v
        hist = sf.setdefault("history", [])
        hist.append({"at": sf["at"], "status": status, "stage": stage})
        del hist[:-30]
        save_sf(root, tid, sf)
        return True


def deps_of(runs):
    m = re.match(r"^\s*(?:after\s*:|waits\s+for)\s*(\d{3}(?:\s*[+,]\s*\d{3})*)", runs or "", re.I)
    return list(dict.fromkeys(re.findall(r"\d{3}", m.group(1)))) if m else []


def unmet(root, tid):
    r = row(root, tid)
    if not r:
        return []
    st = {x["id"]: x["status"] for x in rows(root)}
    return [d for d in deps_of(r["runs"]) if st.get(d) != "done"]


def read_rd(root, tid):
    d = tdir(root, tid)
    try:
        return (d / "rd.md").read_text(encoding="utf-8") if d else ""
    except OSError:
        return ""


def mockup_required(root, tid):
    rd = read_rd(root, tid)
    head = rd.split("\n## ", 1)[0]
    m = re.search(r"\*\*Mockup:\*\*\s*([A-Za-z-]+)", head)
    if m:
        return m.group(1).lower() == "required"
    return bool(re.search(r"^## Mockup\b", rd, re.M))


def spec_complete(root, tid):
    """the ticket's spec is finished: a real rd.md and a writer heartbeat that ended (the same test wv-plan uses for 'needs you')"""
    d = tdir(root, tid)
    rd = (d / "rd.md") if d else None
    if not rd or not rd.is_file() or rd.stat().st_size <= 1500:
        return False
    hb = read_json(Path(root) / "job" / ("status-writer-" + tid + ".json"))
    if str(hb.get("phase", "")) in ("done", "waiting-user"):
        return True
    # no writer ever ran and none can (no brief to write from), but the ticket carries a full spec and its checks: that spec is the plan
    brief = Path(root) / "job" / "briefs" / (tid + ".md")
    return not hb and not brief.is_file() and (d / "eval.md").is_file()


def _mark_mockup_approved(root, tid):
    """`**Approval:** approved by the owner on <date>` in the ticket header (what mockup_approved() and the worker read)."""
    d = tdir(root, tid)
    p = (d / "rd.md") if d else None
    if not p or not p.is_file():
        return
    t = p.read_text(encoding="utf-8")
    line = "**Approval:** approved by the owner on " + now()[:10]
    nl = chr(10)
    head, sep, rest = t.partition(nl + "## ")
    if re.search(r"^\*\*Approval:\*\*.*$", head, re.M):
        head = re.sub(r"^\*\*Approval:\*\*.*$", lambda m: line, head, count=1, flags=re.M)
    elif re.search(r"^\*\*Mockup:\*\*.*$", head, re.M):
        head = re.sub(r"^(\*\*Mockup:\*\*.*)$", lambda m: m.group(1) + nl + line, head, count=1, flags=re.M)
    else:
        head = head.rstrip() + nl + line + nl
    write_atomic(p, head + sep + rest)


def slot_free():
    """True when one more agent (designer, reviewer, writer, worker) fits the hub's agent limit (wv-sessions.py: pool_cap - slots_used).
    A designer or reviewer started by a button must not exceed the limit: with no free slot it is queued and tick() starts it when one frees up.
    Fails open (True) when the count cannot be read."""
    try:
        sp = importlib.util.spec_from_file_location("wv_sessions_slots", Path(__file__).resolve().parent / "wv-sessions.py")
        m = importlib.util.module_from_spec(sp)
        sp.loader.exec_module(m)
        return m.pool_cap() - m.slots_used() >= 1
    except Exception:
        return True


def mockup_approved(root, tid):
    """the owner approved the mockup that is already in the ticket folder: `**Mockup:** approved ...` or `**Approval:** approved ...` in the header"""
    d = tdir(root, tid)
    head = read_rd(root, tid).split("\n## ", 1)[0]
    return bool(d and (d / "mockup.html").is_file() and re.search(r"\*\*(Mockup|Approval):\*\*\s*approved", head, re.I))


def screenshots_needed(root, tid):
    m = re.search(r"^## Screenshots[^\n]*\n([\s\S]*?)(?=^## |\Z)", read_rd(root, tid), re.M)
    if not m:
        return False
    items = [re.sub(r"^[-*\d.)\s|]+", "", ln).strip().lower() for ln in m.group(1).splitlines() if ln.strip()]
    items = [i for i in items if i and i not in ("none", "none.", "n/a", "no", "no screenshots", "not needed", "not applicable", "-")]
    return bool(items)


def screens_present(root, tid):
    d = tdir(root, tid)
    if not d:
        return False
    cands = [d / "delivery" / "screens"]
    cands += list((Path(root) / ".claude" / "worktrees").glob("*/specs/tickets/" + d.name + "/delivery/screens"))
    return any(c.is_dir() and any(f.suffix.lower() in (".png", ".jpg", ".jpeg") for f in c.iterdir()) for c in cands)


def missing_items(root, tid, sf):
    waived = set(sf.get("waived") or [])
    out = []
    if screenshots_needed(root, tid) and not screens_present(root, tid) and "screenshots" not in waived:
        out.append("screenshots (rd.md lists them under ## Screenshots, delivery/screens/ has none)")
    d = tdir(root, tid)
    res = read_json(d / "results.json") if d else {}
    for c in res.get("checks", []) if isinstance(res.get("checks"), list) else []:
        if isinstance(c, dict) and str(c.get("result", c.get("status", ""))).upper() == "SKIP" and "skipped-checks" not in waived:
            out.append("a check was skipped: " + str(c.get("name", c.get("id", "?")))[:80])
    return out


def append_rd(root, tid, title, body):
    d = tdir(root, tid)
    if not d or not (d / "rd.md").is_file():
        return False
    p = d / "rd.md"
    t = p.read_text(encoding="utf-8")
    write_atomic(p, t.rstrip() + "\n\n## " + title + "\n\n" + body.strip() + "\n")
    return True


def reset_ledger(root, tid):
    """A fix or a reopen is a new run on the same ticket and branch: a fresh retry budget, the same ledger entry."""
    p = Path(root) / "job" / "router-state.json"
    st = read_json(p)
    hit = False
    for v in st.values():
        if isinstance(v, list):
            for e in v:
                if isinstance(e, dict) and str(e.get("ticket", "")).startswith(tid + "-") and "branch" in e:
                    e["retriesUsed"], e["attempt"] = 0, 1
                    e.pop("lastDeath", None)
                    e["lastPhase"], e["lastPhaseAt"] = "ready", now()
                    hit = True
    if hit:
        write_atomic(p, json.dumps(st, indent=2) + "\n")


def set_pr_url(root, tid, url):
    p = Path(root) / "job" / "router-state.json"
    st = read_json(p)
    for v in st.values():
        if isinstance(v, list):
            for e in v:
                if isinstance(e, dict) and str(e.get("ticket", "")).startswith(tid + "-"):
                    e["prUrl"] = url
    if st:
        write_atomic(p, json.dumps(st, indent=2) + "\n")


# ---------------------------------------------------------------- reviewer choice
_LOW = re.compile(r"flash|mini|nano|haiku|lite|small|tiny|free|fast|air")
_TOP = re.compile(r"opus|gpt-?5|\bo[34]\b|gemini[^/]*pro|ultra|max|405b|235b")
_HIGH = re.compile(r"sonnet|pro|large|k2|glm-?[5-9]|deepseek|v[3-9]|r1|qwen|coder|turbo|plus")


def model_strength(model_id):
    m = str(model_id).lower().split("/")[-1]
    tier = 0 if _LOW.search(m) else 4 if _TOP.search(m) else 3 if _HIGH.search(m) else 1
    v = re.search(r"(\d+(?:\.\d+)?)", m)
    return tier, float(v.group(1)) if v else 0.0


def suggest_reviewer(models, providers=None):
    """The best reviewer among the configured models: the strongest one that is not a worker model and whose provider is
    connected. models: [{"id": "provider/model", "role": "reviewer"|"worker"|..., "worker": bool}]; providers: connected provider
    ids (None = every provider counts). Returns an id, or None. Pure."""
    usable = []
    for m in models or []:
        mid = str((m or {}).get("id", ""))
        if "/" not in mid:
            continue
        if providers is not None and mid.split("/")[0] not in set(providers):
            continue
        usable.append(m)
    non_worker = [m for m in usable if not m.get("worker") and m.get("role") != "worker"]
    pool = non_worker or usable
    if not pool:
        return None

    def key(m):
        tier, ver = model_strength(m["id"])
        return (-tier, -(1 if m.get("role") == "reviewer" else 0), -ver, m["id"])
    return sorted(pool, key=key)[0]["id"]


def review_options(cfg, claude_ok, connected=None, model_list=None):
    """What the Review menu offers: Claude (when it is available), every configured model, the suggested one, Skip."""
    connected = connected or None  # nothing known as connected: every configured provider counts
    models = (cfg or {}).get("models") or {}
    worker = ((models.get("worker") or {}).get("opencode") or {}).get("model", "")
    seen, cands = set(), []
    for role, v in models.items():
        mid = ((v or {}).get("opencode") or {}).get("model") if isinstance(v, dict) else None
        if mid and mid not in seen:
            seen.add(mid)
            cands.append({"id": mid, "role": role, "worker": mid == worker})
    for mid in model_list or []:
        if mid not in seen and (connected is None or mid.split("/")[0] in set(connected)):
            seen.add(mid)
            cands.append({"id": mid, "role": "", "worker": mid == worker})
    sug = suggest_reviewer(cands, None)  # configured models are the owner's own choice; extra ones were already limited to connected providers
    for c in cands:
        c["suggested"] = c["id"] == sug
    cands.sort(key=lambda c: (not c["suggested"], c["id"]))
    # a reviewer set to Claude on the dashboard (models.reviewer.runtime = "claude") makes Claude the suggested reviewer
    rv = models.get("reviewer") if isinstance(models.get("reviewer"), dict) else {}
    cl_sug = bool(claude_ok) and rv.get("runtime") == "claude"
    cl_model = str((rv.get("claude") or {}).get("model") or "sonnet")
    if cl_sug:
        for c in cands:
            c["suggested"] = False
        sug = None
    return {"claude": {"enabled": bool(claude_ok), "why": "" if claude_ok else "Claude is not signed in or not working right now", "suggested": cl_sug, "model": cl_model}, "models": cands, "suggested": sug, "suggestedBy": "claude" if cl_sug else ("model" if sug else "")}


# ---------------------------------------------------------------- the actions
def _ask(root, tid, kind, text, choices, **extra):
    r = row(root, tid)
    set_status(root, tid, r["status"], ask={"kind": kind, "text": text, "choices": choices, "at": now()}, keep_ask=False, **extra)


def _to_building(root, tid, why):
    set_status(root, tid, "ready", stage="building", review=None, deliver=None, ask=None)
    reset_ledger(root, tid)


def _start_deliver(root, tid, hooks):
    sf = load_sf(root, tid)
    miss = missing_items(root, tid, sf)
    if miss:
        _ask(root, tid, "missing", "Delivery needs " + "; ".join(miss) + ".", [
            {"op": "missing", "choice": "self", "label": "I do it myself", "hint": "Open the PR without it; you add it by hand"},
            {"op": "missing", "choice": "ticket", "label": "Ticket does it", "hint": "Back to Building with this as a task"},
            {"op": "missing", "choice": "done", "label": "Skip to Done", "hint": "No PR is opened"}], missingItems=miss)
        return {"asked": True}
    set_status(root, tid, "delivering", stage="deliver", deliver={"state": "running", "at": now()}, ask=None, keep_ask=False)
    fn = getattr(hooks, "deliver", None) if hooks else None
    if fn:
        fn(root, tid)
    return {"started": True}


def event(root, tid, name, data=None, hooks=None):
    """What finished work reports. Returns (http code, body)."""
    data = data or {}
    r = row(root, tid)
    if not r:
        return 404, {"error": "Ticket " + tid + " is not on the board."}
    sf = load_sf(root, tid)
    st = r["status"]
    with _LOCK:
        if name == "plan_done" and (st == "specifying" or (st == "draft" and sf.get("status") == "specifying")):
            if mockup_required(root, tid) and not mockup_approved(root, tid):
                set_status(root, tid, "designing", stage="design", design=None)
                return 200, {"ok": True, "status": "designing"}
            if mockup_approved(root, tid) and not re.search(r"^## Design" + chr(92) + "b", read_rd(root, tid), re.M):
                append_rd(root, tid, "Design", "Design not run: an approved mockup (`mockup.html`, `mockup-notes.md`) is already in the ticket folder. Build to it.")
            set_status(root, tid, "todo", stage="todo")
            return 200, {"ok": True, "status": "todo"}
        if name == "design_done" and st == "designing":
            if mockup_approved(root, tid):
                set_status(root, tid, "todo", stage="todo", design={"state": "done", "at": now()})
                return 200, {"ok": True, "status": "todo"}
            # the mockup is ready: it waits for the owner (Approve, or Request changes with a note) before the ticket goes to Todo
            set_status(root, tid, "designing", stage="design", design={"state": "review", "at": now()})
            return 200, {"ok": True, "status": "designing", "design": "review"}
        if name == "worker_done" and st in ("in-progress", "ready", "blocked"):
            set_status(root, tid, "in-review", stage="review", review=None)
            return 200, {"ok": True, "status": "in-review"}
        if name == "review_result" and st == "in-review":
            res = str(data.get("state", "")).lower()
            by = (sf.get("review") or {}).get("by", "")
            if res == "clean":
                set_status(root, tid, "delivering", stage="deliver", review={"state": "clean", "by": by, "at": now()}, ask=None)
                _start_deliver(root, tid, hooks)
                return 200, {"ok": True, "status": "delivering"}
            if res == "findings":
                text = str(data.get("text") or "").strip() or "The review found problems."
                n = int(data.get("findings") or 0)
                _ask(root, tid, "findings", ("The review found " + (str(n) + " problem(s)" if n else "problems") + ". Fix them or skip."), [
                    {"op": "fix", "label": "Fix", "primary": True, "hint": "Back to Building with the findings"},
                    {"op": "skip_findings", "label": "Skip", "hint": "Deliver as it is"}], review={"state": "findings", "by": by, "findings": n, "at": now()}, findingsText=text)
                return 200, {"ok": True, "status": "in-review", "asked": True}
            _ask(root, tid, "review-failed", "The review did not finish" + (": " + str(data.get("text"))[:160] if data.get("text") else "") + ".", [
                {"op": "review_again", "label": "Review again", "primary": True}, {"op": "skip_review", "label": "Skip review"}], review={"state": "failed", "by": by, "at": now()})
            return 200, {"ok": True, "status": "in-review", "asked": True}
        if name == "deliver_result" and st == "delivering":
            if data.get("ok", True) and not data.get("error"):
                url = str(data.get("prUrl") or "")
                extra = {"prUrl": url, "deliver": {"state": "done", "at": now()}} if url else {"deliver": {"state": "done", "at": now()}}
                set_status(root, tid, "done", stage="done", **extra)
                if url:
                    set_pr_url(root, tid, url)
                return 200, {"ok": True, "status": "done", "prUrl": url}
            _ask(root, tid, "deliver-failed", "Opening the pull request failed: " + str(data.get("error") or "unknown error")[:200], [
                {"op": "deliver_again", "label": "Try again", "primary": True},
                {"op": "missing", "choice": "self", "label": "I do it myself", "hint": "Mark it done; you open the PR by hand"},
                {"op": "missing", "choice": "done", "label": "Skip to Done"}], deliver={"state": "failed", "at": now()})
            return 200, {"ok": True, "status": "delivering", "asked": True}
    return 409, {"error": "Event " + name + " does not apply to ticket " + tid + " in '" + st + "'."}


def paused_set(root):
    """tickets (3-digit numbers) paused in the project's ledger: the dispatcher starts no worker for them"""
    return {str(x)[:3] for x in (read_json(Path(root) / "job" / "router-state.json").get("paused") or [])}


def set_paused(root, tid, on):
    """pause or resume one ticket: only the project's ledger list changes (zero tokens). A worker already running is not stopped."""
    sp = Path(root) / "job" / "router-state.json"
    d = read_json(sp)
    cur = [str(x) for x in (d.get("paused") or [])]
    keep = [x for x in cur if x[:3] != tid[:3]]
    if on:
        keep.append(tid[:3])
    d["paused"] = keep
    write_atomic(sp, json.dumps(d, indent=2) + "\n")
    return keep


def act(root, tid, op, args=None, hooks=None):
    """An owner action. Returns (http code, body)."""
    args = args or {}
    r = row(root, tid)
    if not r:
        return 404, {"error": "Ticket " + tid + " is not on the board."}
    st, sf = r["status"], load_sf(root, tid)
    ask = sf.get("ask") or {}

    def bad(msg):
        return 409, {"error": msg}
    with _LOCK:
        if op in ("pause", "resume"):
            on = op == "pause"
            if on == (tid[:3] in paused_set(root)):
                return 200, {"ok": True, "paused": on, "note": "Ticket " + tid + (" is already paused." if on else " is not paused.")}
            set_paused(root, tid, on)
            return 200, {"ok": True, "paused": on, "note": ("Ticket " + tid + " paused: no new worker starts for it. A worker that is already running keeps going until it ends or you stop it in the Processes view.") if on else ("Ticket " + tid + " resumed: the dispatcher can start its worker again.")}
        if op == "dispatch":
            if st == "draft":
                set_status(root, tid, "specifying", stage="plan")
                if spec_complete(root, tid):
                    # a ticket that was planned before (migrated or re-dispatched) passes Plan at once: no planner run, no tokens
                    code, body = event(root, tid, "plan_done", {"already": True}, hooks)
                    body["note"] = "Ticket " + tid + " was already planned: Plan passed, now " + body.get("status", "") + "."
                    return code, body
                return 200, {"ok": True, "status": "specifying", "note": "Ticket " + tid + " goes to the planner."}
            if st == "todo":
                w = unmet(root, tid)
                if w:
                    return bad("Ticket " + tid + " waits for " + ", ".join(w) + ": it can be dispatched once they are done.")
                set_status(root, tid, "ready", stage="todo")
                return 200, {"ok": True, "status": "ready", "note": "Ticket " + tid + " is in the worker queue."}
            return bad("Ticket " + tid + " is '" + st + "': only a draft or a todo ticket is dispatched.")
        if op == "design":
            if st != "designing":
                return bad("Ticket " + tid + " is '" + st + "', not in Design.")
            if (sf.get("design") or {}).get("state") == "running":
                return bad("The designer is already working on ticket " + tid + ".")
            if (sf.get("design") or {}).get("state") == "queued":
                return bad("The designer of ticket " + tid + " is already queued for a free agent slot.")
            fn = getattr(hooks, "design", None) if hooks else None
            if fn and not slot_free():
                set_status(root, tid, "designing", stage="design", design={"state": "queued", "at": now()})
                return 200, {"ok": True, "status": "designing", "note": "All agent slots are busy: the designer starts as soon as one is free."}
            set_status(root, tid, "designing", stage="design", design={"state": "running", "at": now()})
            if fn:
                fn(root, tid)
            return 200, {"ok": True, "status": "designing", "note": "The designer started."}
        if op == "approve_design":
            if st != "designing" or (sf.get("design") or {}).get("state") != "review":
                return bad("Ticket " + tid + " has no mockup waiting for approval.")
            _mark_mockup_approved(root, tid)
            set_status(root, tid, "todo", stage="todo", design={"state": "done", "at": now()})
            return 200, {"ok": True, "status": "todo", "note": "Mockup approved."}
        if op == "design_changes":
            note = str(args.get("note") or "").strip()
            if st != "designing" or (sf.get("design") or {}).get("state") not in ("review", "failed"):
                return bad("Ticket " + tid + " has no mockup to change.")
            if not note:
                return bad("Write what to change first.")
            d = tdir(root, tid)
            if d and (d / "mockup.html").is_file():
                shutil.copyfile(d / "mockup.html", d / "mockup.prev.html")  # the designer revises mockup.html; the last one stays for comparison
            append_rd(root, tid, "Mockup changes requested (" + now() + ")", note[:4000])
            brief = Path(root) / "job" / "briefs" / (tid + "-design-changes.md")
            brief.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(brief, "# Mockup changes for ticket " + tid + chr(10) * 2 + "The owner reviewed the mockup and asks for these changes. REVISE the existing `mockup.html` and `mockup-notes.md` in the ticket folder (keep everything that is not mentioned; the previous version is `mockup.prev.html`), run your screenshot check again, and update the notes (list the changes made)." + chr(10) * 2 + "## Owner's changes" + chr(10) * 2 + note[:4000] + chr(10))
            fn = getattr(hooks, "design", None) if hooks else None
            if fn and not slot_free():
                set_status(root, tid, "designing", stage="design", design={"state": "queued", "at": now()})
                return 200, {"ok": True, "status": "designing", "note": "All agent slots are busy: the designer starts as soon as one is free."}
            set_status(root, tid, "designing", stage="design", design={"state": "running", "at": now()})
            if fn:
                fn(root, tid)
            return 200, {"ok": True, "status": "designing", "note": "The designer is revising the mockup."}
        if op == "skip_design":
            if st != "designing":
                return bad("Ticket " + tid + " is '" + st + "', not in Design.")
            append_rd(root, tid, "Design skipped", "The owner skipped the design on " + now() + ": no mockup was made; the worker builds from this ticket alone.")
            set_status(root, tid, "todo", stage="todo", design={"state": "skipped", "at": now()})
            return 200, {"ok": True, "status": "todo"}
        if op in ("review", "review_again"):
            if st != "in-review":
                return bad("Ticket " + tid + " is '" + st + "', not in Review.")
            if (sf.get("review") or {}).get("state") in ("running", "queued"):
                return bad("A review of ticket " + tid + " is already running or queued.")
            by = str(args.get("by") or (sf.get("review") or {}).get("by") or "claude")
            model = str(args.get("model") or "")
            if by == "claude" and not args.get("claudeOk", True):
                return bad("Claude is not available right now. Review with another model or skip the review.")
            if by == "model" and not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._:/-]+", model):
                return bad("Choose a model like provider/model.")
            fn = getattr(hooks, "review", None) if hooks else None
            if fn and not slot_free():
                set_status(root, tid, "in-review", stage="review", review={"state": "queued", "by": by, "model": model, "at": now()}, ask=None)
                return 200, {"ok": True, "status": "in-review", "note": "All agent slots are busy: the review starts as soon as one is free."}
            set_status(root, tid, "in-review", stage="review", review={"state": "running", "by": by, "model": model, "at": now()}, ask=None)
            if fn:
                fn(root, tid, by, model)
            return 200, {"ok": True, "status": "in-review", "note": "Review started (" + (model if by == "model" else "Claude") + ")."}
        if op == "skip_review":
            if st != "in-review":
                return bad("Ticket " + tid + " is '" + st + "', not in Review.")
            set_status(root, tid, "delivering", stage="deliver", review={"state": "skipped", "at": now()}, ask=None)
            _start_deliver(root, tid, hooks)
            return 200, {"ok": True, "status": row(root, tid)["status"]}
        if op == "fix":
            if st != "in-review" or ask.get("kind") != "findings":
                return bad("Ticket " + tid + " has no review findings to fix.")
            append_rd(root, tid, "Addendum: review findings", "The final review found problems; fix every one, with a test that would have caught it, on the same branch.\n\n" + str(sf.get("findingsText") or ""))
            _to_building(root, tid, "fix")
            return 200, {"ok": True, "status": "ready", "stage": "building"}
        if op == "skip_findings":
            if st != "in-review" or ask.get("kind") != "findings":
                return bad("Ticket " + tid + " has no review findings to skip.")
            set_status(root, tid, "delivering", stage="deliver", review={"state": "skipped-findings", "at": now()}, ask=None)
            _start_deliver(root, tid, hooks)
            return 200, {"ok": True, "status": row(root, tid)["status"]}
        if op == "deliver_again":
            if st != "delivering":
                return bad("Ticket " + tid + " is '" + st + "', not in Deliver.")
            return 200, dict({"ok": True}, **_start_deliver(root, tid, hooks), status=row(root, tid)["status"])
        if op == "missing":
            if st != "delivering":
                return bad("Ticket " + tid + " is '" + st + "', not in Deliver.")
            ch = str(args.get("choice") or "")
            if ch == "self":
                items = sf.get("missingItems") or []
                waived = set(sf.get("waived") or [])
                if any("screenshots" in i for i in items):
                    waived.add("screenshots")
                if any("skipped" in i for i in items):
                    waived.add("skipped-checks")
                if ask.get("kind") == "deliver-failed":
                    set_status(root, tid, "done", stage="done", ask=None, note="PR opened by the owner")
                    return 200, {"ok": True, "status": "done"}
                set_status(root, tid, "delivering", stage="deliver", waived=sorted(waived), ask=None)
                out = _start_deliver(root, tid, hooks)
                return 200, dict({"ok": True, "status": row(root, tid)["status"]}, **out)
            if ch == "ticket":
                append_rd(root, tid, "Addendum: missing before delivery", "Delivery was held: " + "; ".join(sf.get("missingItems") or ["something required"]) + ".\nDo it on the same branch, then the ticket is reviewed and delivered again.")
                _to_building(root, tid, "missing")
                return 200, {"ok": True, "status": "ready", "stage": "building"}
            if ch == "done":
                set_status(root, tid, "done", stage="done", ask=None, note="skipped delivery")
                return 200, {"ok": True, "status": "done"}
            return bad("Choose self, ticket or done.")
        if op == "note":
            note = str(args.get("note") or "").strip()
            if st != "done":
                return bad("Ticket " + tid + " is '" + st + "': a note re-opens a Done ticket only.")
            if not note:
                return bad("Write what is wrong first.")
            append_rd(root, tid, "Addendum (re-opened " + now() + ")", note[:4000])
            _to_building(root, tid, "reopen")
            return 200, {"ok": True, "status": "ready", "stage": "building"}
        if op == "retry":
            if st not in NEED:
                return bad("Ticket " + tid + " is '" + st + "', not needs-you.")
            stg = stage_of(st, sf)
            target = ENTRY_STATUS.get(stg, "ready")
            set_status(root, tid, target, stage=stg, review=None if stg == "review" else sf.get("review"))
            if stg == "building":
                reset_ledger(root, tid)
            return 200, {"ok": True, "status": target, "stage": stg}
    return 400, {"error": "Unknown operation '" + op + "'."}


# ---------------------------------------------------------------- tick + annotate
def live_tickets(root):
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("wv_sessions", Path(__file__).resolve().parent / "wv-sessions.py")
        ws = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ws)
        return {s["ticket"] for s in ws.live() if ws.norm(s["root"]) == ws.norm(root)}
    except Exception:
        return set()


def _mtime(p):
    try:
        return Path(p).stat().st_mtime
    except OSError:
        return 0.0


def _ts(iso):
    try:
        return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return 0.0


GUARDED = ("in-review", "delivering", "done")  # statuses only the engine may enter (review, deliver, done are its stages)
GUARD_GRACE = 10  # seconds: a writer that went through set_status is mid-write (board first, stage file last)


def guard(root, now_ts=None):
    """Cheap engine guard: a board row in a stage-owned status (in-review / delivering / done) that the engine did not put there
    (its own record says otherwise) was set by something else, e.g. an agent ignoring its rules. Logged to job/stage/violations.log
    and put back to the engine's last known status. Never touches a ticket whose engine history is empty (a legacy ticket), and
    waits GUARD_GRACE seconds after the last board write so a writer going through set_status is never fought. Returns the fixed ids."""
    fixed = []
    try:
        if (now_ts or time.time()) - _mtime(board_path(root)) < GUARD_GRACE:
            return fixed
    except Exception:
        return fixed
    for r in rows(root):
        tid, st = r["id"], r["status"]
        if st not in GUARDED:
            continue
        sf = load_sf(root, tid)
        eng = (sf.get("status") or "").lower()
        if not sf.get("history") or eng not in STATUSES or eng == st:
            continue
        try:
            with open(Path(root) / "job" / "stage" / "violations.log", "a", encoding="utf-8") as f:
                f.write("%s %s board=%s engine=%s: not set by the engine, restored\n" % (now(), tid, st, eng))
            set_status(root, tid, eng, stage=sf.get("stage") if sf.get("stage") in STAGES else None, keep_ask=True)
            fixed.append(tid)
        except Exception:
            pass
    return fixed


def tick(root, live=None, hooks=None):
    """Zero-token advance of every ticket whose work is finished. Returns the list of what moved."""
    moved = []
    live = live_tickets(root) if live is None else set(live)
    guard(root)
    for r in rows(root):
        tid, st, sf = r["id"], r["status"], load_sf(root, r["id"])
        d = tdir(root, tid)
        ev = None
        if st == "designing" and (sf.get("design") or {}).get("state") == "queued" and hooks and getattr(hooks, "design", None) and slot_free():
            set_status(root, tid, "designing", stage="design", design={"state": "running", "at": now()})
            hooks.design(root, tid)
            moved.append((tid, "queued designer started"))
            continue
        if st == "in-review" and (sf.get("review") or {}).get("state") == "queued" and hooks and getattr(hooks, "review", None) and slot_free():
            rv = sf.get("review") or {}
            set_status(root, tid, "in-review", stage="review", review={"state": "running", "by": rv.get("by"), "model": rv.get("model", ""), "at": now()})
            hooks.review(root, tid, rv.get("by") or "claude", rv.get("model") or "")
            moved.append((tid, "queued review started"))
            continue
        if st == "draft" and sf.get("status") == "specifying":
            ev = ("plan_done", {})  # the planner writes `draft` when its spec is finished
        elif st == "in-progress" and tid not in live and d:
            res = d / "results.json"
            if res.is_file() and _mtime(res) > _ts(sf.get("at", "")) and read_json(res).get("finishedAt"):
                ev = ("worker_done", {})
        elif st == "in-review" and (sf.get("review") or {}).get("state") == "running":
            rv = read_json(Path(root) / "job" / ("review-" + tid + ".json"))
            if rv.get("state") in ("clean", "findings", "failed") and _ts(rv.get("finishedAt", "")) >= _ts((sf.get("review") or {}).get("at", "")):
                text = ""
                try:
                    text = (d / "review.md").read_text(encoding="utf-8") if d else ""
                except OSError:
                    pass
                ev = ("review_result", {"state": rv["state"], "findings": rv.get("findings", 0), "text": text})
        elif st == "delivering" and not sf.get("ask") and (sf.get("deliver") or {}).get("state") != "running":
            _start_deliver(root, tid, hooks)
            moved.append((tid, "deliver started"))
            continue
        if ev:
            code, body = event(root, tid, ev[0], ev[1], hooks)
            if code == 200:
                moved.append((tid, ev[0] + " -> " + str(body.get("status"))))
    return moved


def annotate(root, tickets, ctx=None):
    """Adds stage fields to the server's ticket dicts (id, status): stage, needsYou, ask, waits, prUrl, actions."""
    ctx = ctx or {}
    by = {t["id"]: t for t in tickets}
    for t in tickets:
        tid, st = t["id"], str(t.get("status", "")).lower()
        sf = load_sf(root, tid)
        stg = stage_of(st, sf)
        ask = sf.get("ask") or None
        runs = t.get("runs") or (row(root, tid) or {}).get("runs", "")
        st_of = {x["id"]: x["status"] for x in rows(root)}
        waits = [d for d in deps_of(runs) if (by.get(d) or {}).get("status", st_of.get(d)) != "done"]
        acts = []
        if st in NEED:
            acts = [{"op": "retry", "label": "Retry", "primary": True}]
        elif ask:
            acts = list(ask.get("choices") or [])
        elif st == "draft":
            acts = [{"op": "dispatch", "label": "Dispatch", "primary": True}]
        elif st == "designing":
            if (sf.get("design") or {}).get("state") == "review":
                acts = [{"op": "approve_design", "label": "Approve mockup", "primary": True}, {"op": "design_changes", "type": "changes", "label": "Request changes", "title": "Request changes to the mockup", "hint": "What should the designer change? It revises the mockup and asks you again."}]
            elif (sf.get("design") or {}).get("state") not in ("running", "queued"):
                acts = [{"op": "design", "label": "Design", "primary": True}, {"op": "skip_design", "label": "Skip design"}]
        elif st == "todo":
            acts = [{"op": "dispatch", "label": "Dispatch", "primary": True, "disabled": bool(waits), "why": ("Waits for " + ", ".join(waits)) if waits else ""}]
        elif st == "in-review" and (sf.get("review") or {}).get("state") not in ("running", "queued"):
            acts = [{"op": "review", "type": "review-menu", "label": "Review", "options": ctx.get("reviewOptions")}]
        elif st == "done":
            acts = [{"op": "note", "type": "note", "label": "Re-open with a note"}]
        is_paused = tid[:3] in paused_set(root)
        if is_paused:
            acts = [{"op": "resume", "label": "Resume", "primary": True}] + [a for a in acts if a.get("op") not in ("dispatch",)]
        elif st in ("ready", "in-progress", "specifying"):
            acts = list(acts) + [{"op": "pause", "label": "Pause"}]
        t.update({"paused": is_paused, "stage": stg, "needsYou": st in NEED or bool(ask), "ask": ({"kind": ask.get("kind"), "text": ask.get("text")} if ask else None),
                  "waits": waits, "prUrl": sf.get("prUrl") or "", "actions": acts,
                  "stageState": {k: (sf.get(k) or {}).get("state") for k in ("design", "review", "deliver") if sf.get(k)}})
    return tickets


class Hooks:
    """Base for the side effects that start a process: designer, reviewer, PR. Subclass and pass to act/event/tick."""
    design = review = deliver = None


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, root = argv[1], argv[2]
    if cmd == "act" and len(argv) >= 5:
        args = json.loads(argv[5]) if len(argv) > 5 else {}
        code, body = act(root, argv[3], argv[4], args)
        print(json.dumps(body))
        return 0 if code == 200 else 1
    if cmd == "tick":
        for m in tick(root):
            print(m[0] + ": " + m[1])
        return 0
    if cmd == "show":
        ts = [{"id": r["id"], "status": r["status"], "runs": r["runs"]} for r in rows(root)]
        for t in annotate(root, ts):
            print(t["id"], t["status"], "->", t["stage"], "NEEDS YOU" if t["needsYou"] else "", [a["label"] for a in t["actions"]])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
