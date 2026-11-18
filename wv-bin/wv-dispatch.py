#!/usr/bin/env python3
"""wv-dispatch.py [--dry]

Starts the workers of ready tickets WITHOUT the router.

Until now the router started a worker as its own subagent: its `opencode run` cycle then blocked for as long as the worker built the
ticket (minutes to hours), looking "stuck running the agents", unable to serve any other project meanwhile, and a worker died the
moment its router session ended or was cancelled ("Subagent cancelled"). Now a worker is a session of its own: this starts
`opencode run --agent worker` as a detached process in the project's folder, independent of the router loop, the dashboard and this
script. The router is left with its short jobs: reconcile, verify, land, answer.

Rules (same as the router's Step 2, decided in code): a ticket is dispatched when it is `ready`, not paused, every `waits for NNN`
dependency is `done`, it has no live worker, the fleet is not switched off / degraded, and a worker slot is free (the hub's
concurrency.maxParallelWorkers minus the workers live on the computer). Recording: ledger entry (attempt 1, phase building,
budget stamp, port and test account of the slot) and the board row `in-progress`."""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location("wv_settle", HERE / "wv-settle.py")
st = importlib.util.module_from_spec(_s)
_s.loader.exec_module(st)
ws = st.ws


def hub_cfg():
    hub = ws.read_json(Path.home() / ".workov" / "hub.json").get("root", "")
    return ws.read_json(Path(hub) / "specs" / "workov.config.json") if hub else {}


def died_of_rate_limit(base, num):
    """the worker's last run ended on a provider rate limit (HTTP 429): a short throttle, so it is retried after a short wait"""
    log = Path(base) / "job" / "logs" / (num + "-worker-run.log")
    try:
        if time.time() - log.stat().st_mtime < 20:
            return False  # still writing: not dead
        tail = log.read_bytes()[-6000:].decode("utf-8", errors="replace")
    except OSError:
        return False
    return "HTTP 429" in tail[-1500:]  # the error is the last thing the dead run wrote


def due(root, free):
    """tickets of this project to start now: [(num, slug)], at most `free` of them"""
    base = Path(root)
    try:
        board = (base / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        return []
    status = ws.board_status(root)
    state = ws.read_json(base / "job" / "router-state.json")
    paused = {str(x)[:3] for x in state.get("paused", []) or []}
    busy = {s["ticket"] for s in ws.live() if ws.norm(s["root"]) == ws.norm(root)}
    ledger = {str(e.get("ticket", ""))[:3]: e for e in state.get("dispatched", []) or [] if isinstance(e, dict)}
    out = []
    for m in re.finditer(r"^\|\s*(\d{3})\s*\|[^|]*\|\s*([a-z-]+)\s*\|\s*([a-z]+)?\s*\|\s*([^|]*)\|", board, re.M):
        num, stt, mode, runs = m.group(1), m.group(2), (m.group(3) or "solo"), m.group(4)
        if num in paused or num in busy or mode != "solo":
            continue
        if stt == "in-progress":
            ent = ledger.get(num)  # an orphan: its worker is gone (cancelled, crashed) and nothing is dispatching it
            try:
                age = time.time() - datetime.strptime(str(ent.get("lastPhaseAt", ""))[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp() if ent else 1e9
            except Exception:
                age = 1e9
            if age < 300 and not (age >= 45 and died_of_rate_limit(base, num)):
                continue
        elif stt != "ready":
            continue
        deps = re.findall(r"\b(\d{3})\b", runs) if runs.strip().lower().startswith(("waits for", "after")) else []
        if any(status.get(d) != "done" for d in deps):
            continue
        if len(out) >= free:
            break
        slug = next((d.name for d in sorted((base / "specs" / "tickets").glob(num + "-*"))), None)
        if slug:
            out.append((num, slug))
    return out


def find_opencode():
    """the real opencode.exe: the pnpm shim (opencode.CMD) cannot take a long multi-word prompt from a detached process"""
    import glob
    home = str(Path.home()).replace("\\", "/")
    pats = [home + "/AppData/Local/pnpm/global/v*/*/node_modules/@opencode/cli/bin/opencode.exe",
            home + "/AppData/Local/pnpm/global/v*/*/node_modules/.pnpm/@opencode*/node_modules/@opencode/cli/bin/opencode.exe",
            home + "/AppData/Local/pnpm/global/v*/node_modules/@opencode/cli/bin/opencode.exe"]
    found = [f for p in pats for f in glob.glob(p)]
    if found:
        return max(found, key=os.path.getmtime)
    return shutil.which("opencode") or "opencode"


def service_args(opencode):
    """`opencode run` starts the background service itself. When the service is reported stopped but a leftover server (often one with
    a password that is not ours) still holds the service port, that start fails and the worker dies at once ("Managed service port ...
    already in use"). Then the worker runs on its own private server (`--standalone`) and leaves that process alone."""
    import socket
    try:
        st = subprocess.run([opencode, "service", "status"], capture_output=True, text=True, timeout=20).stdout.lower()
        if "stopped" not in st:
            return []
        port = int(os.environ.get("WV_OPENCODE_PORT") or 28894)
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return ["--standalone"]
    except Exception:
        return []


COOLDOWN_SECONDS = 180  # a model that answered HTTP 429 is left alone this long


def _cooldown_file():
    return Path.home() / ".workov" / "model-cooldown.json"


def model_cooling():
    now = time.time()
    d = ws.read_json(_cooldown_file())
    return {m: u for m, u in d.items() if isinstance(u, (int, float)) and u > now}


def mark_cooling(model):
    if not model:
        return
    d = model_cooling()
    d[model] = time.time() + COOLDOWN_SECONDS
    f = _cooldown_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(d), encoding="utf-8")


def model_load(default=None):
    """{model: workers running now}, from the `-m <model>` of the `opencode run` worker processes (a worker started without -m runs on `default`, the primary model)"""
    if os.name != "nt":
        return {}
    cmd = "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Select-Object CommandLine | ConvertTo-Json -Compress"
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=60).stdout
        d = json.loads(out) if out.strip() else []
    except Exception:
        return {}
    load = {}
    for p in (d if isinstance(d, list) else [d]):
        cl = p.get("CommandLine") or ""
        if "Build ticket" not in cl:
            continue
        m = re.search(r" -m (\S+) ", cl)
        key = m.group(1) if m else default
        if key:
            load[key] = load.get(key, 0) + 1
    return load


def choose_model(cfg):
    """The worker model for a new run. models.worker.opencode.model is the primary; models.worker.opencode.fallbacks are the others.
    One worker per model at a time (maxPerModel, default 1) when there is more than one model, so parallel workers do not share one
    provider's rate limit; a model in cooldown after a 429 is skipped. None = no pool configured: the agent's own model is used."""
    oc = (((cfg.get("models") or {}).get("worker") or {}).get("opencode")) or {}
    models = [m for m in [oc.get("model")] + list(oc.get("fallbacks") or []) if m]
    models = list(dict.fromkeys(models))
    if len(models) < 2:
        return None
    cap = int(oc.get("maxPerModel") or 1)
    cooling, load = model_cooling(), model_load(models[0])
    ok = [m for m in models if m not in cooling] or sorted(models, key=lambda m: cooling.get(m, 0))[:1]
    for m in ok:
        if load.get(m, 0) < cap:
            return m
    return min(ok, key=lambda m: load.get(m, 0))


def launch(root, name, num, slug, dry):
    base = Path(root)
    cfg = ws.read_json(base / "specs" / "workov.config.json")
    conc = cfg.get("concurrency", {}) or {}
    sp = base / "job" / "router-state.json"
    state = ws.read_json(sp)
    ledger = [e for e in state.get("dispatched", []) or [] if isinstance(e, dict)]
    used = {int(e["port"]) for e in ledger if isinstance(e.get("port"), int) and not str(e.get("ticket", "")).startswith(num)}
    b = int(conc.get("workerBasePort") or 3101)
    slot = next(n for n in range(1, 50) if b + n - 1 not in used)
    port, account = b + slot - 1, "t%03d" % slot
    turns = int(((cfg.get("budget") or {}).get("maxTurns")) or 300)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    root_fwd = str(base).replace("\\", "/")
    prompt = ("Build ticket " + num + " solo. Project folder (work only inside it): " + root_fwd + ". Ticket folder path: specs/tickets/" + slug +
              ". Assigned dev server port: " + str(port) + ". Assigned test account: " + account + ". maxTurns: " + str(turns) +
              ". Follow your worker instructions end to end in your own git worktree, write results.md and results.json, then stop. "
              "Never remove a worktree or delete files outside your own worktree.")
    print(name + ": starting the worker of " + slug + " (port " + str(port) + ", " + account + ")")
    if dry:
        return
    opencode = find_opencode()
    prev = next((e for e in ledger if str(e.get("ticket", "")).startswith(num)), None)
    if prev and prev.get("model") and died_of_rate_limit(base, num):
        mark_cooling(prev["model"])
    model = choose_model(hub_cfg())
    env = dict(os.environ)
    wvbin = str(Path.home() / ".wv-bin")
    env["PATH"] = wvbin + os.pathsep + env.get("PATH", "")
    env["BASH_ENV"] = wvbin.replace("\\", "/") + "/wv-bashenv.sh"
    env["WV_APPROVALS"] = "auto"
    # a private opencode server (`--standalone`) takes the session directory from PWD, and this process inherits the hub loop shell's
    # PWD: the worker would be recorded under the hub folder, not seen as running by the next cycle, and launched again every few minutes
    env["PWD"] = str(base).replace("\\", "/")
    logdir = base / "job" / "logs"
    logdir.mkdir(parents=True, exist_ok=True)
    log = open(logdir / (num + "-worker-run.log"), "ab")
    flags = (0x00000008 | 0x00000200 | 0x08000000) if os.name == "nt" else 0
    subprocess.Popen([opencode, "run", *service_args(opencode), *(["-m", model] if model else []), "--auto", "--agent", "worker", "--title", "Worker for ticket " + num + " " + slug.split("-", 1)[-1].replace("-", " "), prompt],
                     cwd=str(base), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)
    ent = next((e for e in ledger if str(e.get("ticket", "")).startswith(num)), None)
    if ent is None:
        ent = {"ticket": slug, "agentId": "", "port": port, "account": account, "attempt": 1, "retriesUsed": 0, "maxRetries": 2,
               "budget": {"usd": 3.0, "turns": turns, "turnsUsed": 0, "estCostUsd": 0.0}, "branch": "feat/" + slug, "lastDeath": None}
        ledger.append(ent)
    ent["lastPhase"], ent["lastPhaseAt"] = "building", now
    if model:
        ent["model"] = model
    state["dispatched"] = ledger
    state.setdefault("budgetSince", {}).setdefault(num, now)
    state["updatedAt"] = now
    st.write_atomic(sp, json.dumps(state, indent=2) + chr(10))
    st.set_board(root, num, "in-progress")


def _lock():
    """one dispatch run at a time on the machine: the router loop and the dashboard tick both run this; a stale lock (>120 s) is taken over"""
    lk = Path.home() / ".workov" / "dispatch.lock"
    lk.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(str(lk), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return lk
        except FileExistsError:
            try:
                if time.time() - lk.stat().st_mtime > 120:
                    lk.unlink()
                    continue
            except OSError:
                pass
            return None
    return None


def main():
    if "--dry" not in sys.argv:
        lk = _lock()
        if lk is None:
            return 0
        try:
            return _main()
        finally:
            try:
                lk.unlink()
            except OSError:
                pass
    return _main()


def _main():
    dry = "--dry" in sys.argv
    conc = hub_cfg().get("concurrency", {}) or {}
    cap = ws.pool_cap()
    free = cap - ws.slots_used()
    if free <= 0:
        return 0
    for name, root in ws.fleets():
        base = Path(root)
        if (base / "job" / "fleet-off").exists() or free <= 0:
            continue
        if str(ws.read_json(base / "job" / "swarm-state.json").get("status", "")).lower() in ("degraded", "paused"):
            continue
        for num, slug in due(root, free):
            launch(root, name, num, slug, dry)
            free -= 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
