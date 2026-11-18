"""End-to-end test of the stage pipeline against the REAL dashboard server in a scratch fixture (no model, no network, no real project).

  python tests/e2e_stages.py <installed-fleet-folder> [--serve]

Copies the installed fleet's scripts and dashboard into a temp folder, applies patches/stages-v2.cjs there, starts the server on a free
port with HOME pointed at a temp folder (so ~/.workov and ~/.wv-bin are never touched), creates test tickets 001-004 and drives every
transition through POST /api/action (action wv_stage) with fake worker / reviewer / designer / PR outcomes (WV_STAGE_FAKE=1).
--serve leaves the server running (prints port and token) for a browser check; Ctrl+C cleans up."""
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
FLEET = Path(sys.argv[1]).resolve()
SERVE = "--serve" in sys.argv
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  <- " + str(detail)))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


tmp = Path(tempfile.mkdtemp(prefix="wvstages-"))
fx, home = tmp / "fleet", tmp / "home"
(home / ".wv-bin").mkdir(parents=True)
for f in (KIT / "wv-bin").glob("*.py"):
    shutil.copy2(f, home / ".wv-bin" / f.name)
for sub in (".claude/scripts", ".claude/dashboard", ".claude/agents", ".opencode/agents"):
    if (FLEET / sub).is_dir():
        shutil.copytree(FLEET / sub, fx / sub, ignore=shutil.ignore_patterns("__pycache__"))
for d in ("specs/tickets", "job"):
    (fx / d).mkdir(parents=True, exist_ok=True)
port = free_port()
cfg = {"version": "0.1", "harness": "both", "preset": "hybrid-bridge",
       "concurrency": {"maxParallelWorkers": 2, "mainPort": free_port(), "reproducerPort": free_port(), "workerBasePort": 3961, "dashboardPort": port},
       "watchdog": {"intervalMinutes": 10, "stallThresholdMinutes": 15, "autoCompactWindow": 150000}, "regression": {"everyNMerges": 1},
       "models": {"worker": {"opencode": {"model": "opencode-go/kimi-k2.7-code"}}, "reviewer": {"opencode": {"model": "opencode-go/deepseek-v4-pro"}},
                  "tester": {"opencode": {"model": "opencode-go/glm-5.3-flash"}}},
       "dashboard": {"enabled": True, "autoStartWithRouter": False, "port": port, "allowRemoteActions": True, "tunnel": {"provider": "cloudflared", "namedTunnel": ""}}}
(fx / "specs" / "workov.config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
(fx / "job" / "fleet-off").write_text("test\n", encoding="utf-8")  # the server never starts a router or a worker here
env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), WV_BIN_DIR=str(home / ".wv-bin"), WV_STAGE_FAKE="1", WV_STAGE_CLAUDE="1", PYTHONIOENCODING="utf-8")
r = subprocess.run(["node", str(KIT / "patches" / "stages-v2.cjs")], cwd=str(fx), capture_output=True, text=True)
_applied = ("# ---- stages v2" in (fx / ".claude/scripts/dashboard-server.py").read_text(encoding="utf-8", errors="replace")
            and "/* stages v2:" in (fx / ".claude/dashboard/index.html").read_text(encoding="utf-8", errors="replace"))
# an installed fleet is already patched by install.sh (then the patch run is a no-op); a raw fleet is patched here
check("patch applies", _applied and "anchors not found" not in r.stdout, r.stdout + r.stderr)
r2 = subprocess.run(["node", str(KIT / "patches" / "stages-v2.cjs")], cwd=str(fx), capture_output=True, text=True)
check("patch is idempotent", r2.stdout.strip() == "" and r2.returncode == 0, r2.stdout)
r = subprocess.run([sys.executable, "-m", "py_compile", str(fx / ".claude/scripts/dashboard-server.py")], capture_output=True, text=True)
check("py_compile server", r.returncode == 0, r.stderr)
subprocess.run([sys.executable, str(fx / ".claude/scripts/apply-setup.py"), "--config", str(fx / "specs/workov.config.json")], cwd=str(fx), capture_output=True, text=True, env=env, timeout=90)
try:
    token = json.loads((fx / "job" / "dashboard-auth.json").read_text(encoding="utf-8"))["authToken"]
except Exception:
    token = ""
check("fixture token", bool(token))

TK = fx / "specs" / "tickets"


def mk(tid, status, runs="alongside", mockup="**Mockup:** none", shots="- the button"):
    d = TK / (tid + "-tst-" + tid)
    d.mkdir(exist_ok=True)
    (d / "rd.md").write_text("# TST %s\n\n**Status:** %s\n%s\n\n## Screenshots\n%s\n" % (tid, status, mockup, shots), encoding="utf-8")


def write_board(rows):
    (TK / "BOARD.md").write_text("# Ticket Board\n\nStatus: x\n\n| #   | Title | Status | Mode | Runs |\n| --- | --- | --- | --- | --- |\n" +
                                 "\n".join("| %s | TST %s | %s | solo | %s |" % (t, t, s, r) for t, s, r in rows) + "\n", encoding="utf-8")


def board_status(tid):
    m = re.search(r"^\|\s*" + tid + r"\s*\|[^|]*\|\s*([a-z-]+)\s*\|", (TK / "BOARD.md").read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else None


def rd(tid):
    return next(TK.glob(tid + "-*")).joinpath("rd.md").read_text(encoding="utf-8")


def set_board_line(tid, status):  # an agent (planner, router) writing the board by hand
    t = (TK / "BOARD.md").read_text(encoding="utf-8")
    (TK / "BOARD.md").write_text(re.sub(r"(^\|\s*" + tid + r"\s*\|[^|]*\|\s*)[a-z-]+(\s*\|)", lambda m: m.group(1) + status + m.group(2), t, count=1, flags=re.M), encoding="utf-8")


def call(method, path, payload=None, tok=True):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=int(os.environ.get("WV_E2E_TIMEOUT", "20")))
    h = {"Content-Type": "application/json"} if payload is not None else {}
    if tok:
        h["Authorization"] = "Bearer " + token
    c.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=h)
    rr = c.getresponse()
    body = rr.read()
    c.close()
    try:
        return rr.status, json.loads(body)
    except Exception:
        return rr.status, body


def act(tid, op, **kw):
    return call("POST", "/api/action", dict({"action": "wv_stage", "ticket": tid, "op": op}, **kw))


def ev(tid, name, data=None):
    return act(tid, "event", name=name, data=data or {})


def tick():
    return act("001", "tick", live=[])


def tickets():
    s, d = call("GET", "/api/state")
    return {t["id"]: t for t in d.get("tickets", [])} if s == 200 else {}


def worker_starts(tid):  # what wv-dispatch and wv-adopt call to flip ready -> in-progress
    code = ("import importlib.util,sys;sp=importlib.util.spec_from_file_location('s',sys.argv[1]);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);m.set_board(sys.argv[2],sys.argv[3],'in-progress')")
    subprocess.run([sys.executable, "-c", code, str(home / ".wv-bin" / "wv-settle.py"), str(fx), tid], check=True, env=env)


def worker_finishes(tid):
    time.sleep(1.1)
    d = next(TK.glob(tid + "-*"))
    (d / "results.json").write_text(json.dumps({"ticket": tid, "finishedAt": "2026-01-01T00:00:00Z", "checks": []}), encoding="utf-8")


def add_screens(tid):
    sc = next(TK.glob(tid + "-*")) / "delivery" / "screens"
    sc.mkdir(parents=True, exist_ok=True)
    (sc / "01-x.png").write_bytes(b"png")


proc = None
try:
    write_board([("001", "draft", "alongside"), ("002", "draft", "waits for 001: needs the first"), ("003", "draft", "alongside"), ("004", "done", "alongside")])
    mk("001", "draft", mockup="**Mockup:** required")
    mk("002", "draft")
    mk("003", "draft", mockup="**Mockup:** required")
    mk("004", "done")
    log = open(tmp / "server.log", "wb")
    proc = subprocess.Popen([sys.executable, str(fx / ".claude/scripts/dashboard-server.py"), "--port", str(port)], cwd=str(fx), env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            if call("GET", "/api/state")[0] in (200, 401):
                break
        except OSError:
            time.sleep(0.5)
    st, _ = call("GET", "/api/state")
    check("server answers /api/state", st == 200, st)

    # ---- 001: happy path with a mockup
    t = tickets()["001"]
    check("draft card: Dispatch button, stage draft", t["stage"] == "draft" and [a["op"] for a in t["actions"]] == ["dispatch"], t)
    check("dispatch draft -> specifying", act("001", "dispatch")[0] == 200 and board_status("001") == "specifying")
    check("planner running: no early move", tick()[1]["moved"] == [] and board_status("001") == "specifying")
    check("old status path still lands in the stage file", call("POST", "/api/action", {"action": "set_ticket_status", "ticket": "001", "status": "specifying"})[0] == 200)
    set_board_line("001", "draft")  # the planner finishes: `draft`
    check("tick: planner done + Mockup required -> designing", tick()[1]["moved"] and board_status("001") == "designing", board_status("001"))
    t = tickets()["001"]
    check("designing card: Design + Skip design buttons", [a["op"] for a in t["actions"]] == ["design", "skip_design"] and t["stage"] == "design", t["actions"])
    check("Design starts the designer", act("001", "design")[0] == 200 and tickets()["001"]["stageState"].get("design") == "running")
    check("designer finished -> todo", ev("001", "design_done")[0] == 200 and board_status("001") == "todo")
    check("todo: Dispatch enabled", tickets()["001"]["actions"][0]["op"] == "dispatch" and not tickets()["001"]["actions"][0]["disabled"])
    check("dispatch todo -> ready (queue)", act("001", "dispatch")[0] == 200 and board_status("001") == "ready")
    worker_starts("001")
    t = tickets()["001"]
    check("worker start (the one path) -> in-progress, Building", board_status("001") == "in-progress" and t["stage"] == "building", (board_status("001"), t.get("stage")))
    check("rd.md header follows the status", "**Status:** in-progress" in rd("001"))
    worker_finishes("001")
    check("tick: worker done -> in-review", tick()[1]["moved"] and board_status("001") == "in-review")
    t = tickets()["001"]
    menu = next((a for a in t["actions"] if a.get("type") == "review-menu"), None)
    check("review menu: Claude enabled, models listed, ONE suggested", menu and menu["options"]["claude"]["enabled"] and sum(1 for m in menu["options"]["models"] if m["suggested"]) == 1 and menu["options"]["suggested"] == "opencode-go/deepseek-v4-pro", menu)
    check("review with a model: running", act("001", "review", by="model", model="opencode-go/deepseek-v4-pro")[0] == 200 and tickets()["001"]["stageState"].get("review") == "running")
    check("second review refused while running", act("001", "review", by="claude")[0] == 409)
    add_screens("001")
    check("review clean -> delivering", ev("001", "review_result", {"state": "clean"})[0] == 200 and board_status("001") == "delivering")
    check("PR opened -> done with the PR link on the card", ev("001", "deliver_result", {"ok": True, "prUrl": "https://git.example/pr/1"})[0] == 200 and board_status("001") == "done" and tickets()["001"]["prUrl"] == "https://git.example/pr/1")

    # ---- 002: depends on 001, no mockup, review skipped
    check("002 draft -> specifying", act("002", "dispatch")[0] == 200)
    set_board_line("002", "draft")
    tick()
    check("no mockup: planner done -> todo straight away", board_status("002") == "todo", board_status("002"))
    check("002 skip review path later; dependency met (001 done): dispatch ok", tickets()["002"]["waits"] == [] and act("002", "dispatch")[0] == 200)

    # ---- dependency chain with an unmet dependency
    write_board([("001", "todo", "alongside"), ("002", "todo", "waits for 001: needs the first"), ("003", "draft", "alongside"), ("004", "done", "alongside")])
    t2 = tickets()["002"]
    check("waits-for chip data + Dispatch disabled and explained", t2["waits"] == ["001"] and t2["actions"][0]["disabled"] and "001" in t2["actions"][0]["why"], t2["actions"])
    code, body = act("002", "dispatch")
    check("dispatch refused while 001 is not done", code == 409 and "001" in body["error"] and board_status("002") == "todo", body)
    set_board_line("001", "done")
    check("dispatch allowed once 001 is done", act("002", "dispatch")[0] == 200 and board_status("002") == "ready")
    worker_starts("002")
    worker_finishes("002")
    tick()
    check("002 in-review; review skipped -> delivering (screenshots listed, none present -> ask)", act("002", "skip_review")[0] == 200 and board_status("002") == "delivering" and tickets()["002"]["ask"]["kind"] == "missing", tickets()["002"].get("ask"))
    t = tickets()["002"]
    check("missing-item ask offers: I do it myself / Ticket does it / Skip to Done", [a["label"] for a in t["actions"]] == ["I do it myself", "Ticket does it", "Skip to Done"], t["actions"])
    check("'I do it myself' goes on delivering", act("002", "missing", choice="self")[0] == 200 and board_status("002") == "delivering" and not tickets()["002"]["ask"])
    check("PR opened for 002 -> done", ev("002", "deliver_result", {"ok": True, "prUrl": "https://git.example/pr/2"})[0] == 200 and board_status("002") == "done")

    # ---- 003: skip design, findings -> Fix, then Ticket does it, then Skip to Done
    write_board([("001", "done", "alongside"), ("002", "done", "alongside"), ("003", "draft", "alongside"), ("004", "done", "alongside")])
    act("003", "dispatch")
    set_board_line("003", "draft")
    tick()
    check("003 mockup required -> designing", board_status("003") == "designing")
    check("Skip design writes the note and goes to todo", act("003", "skip_design")[0] == 200 and board_status("003") == "todo" and "Design skipped" in rd("003"))
    act("003", "dispatch")
    worker_starts("003")
    worker_finishes("003")
    tick()
    check("003 in-review", board_status("003") == "in-review")
    act("003", "review", by="claude")
    ev("003", "review_result", {"state": "findings", "findings": 2, "text": "1. save loses data\n2. no test"})
    t = tickets()["003"]
    check("findings: Needs-you ask with Fix / Skip, stays in Review", t["needsYou"] and t["stage"] == "review" and [a["label"] for a in t["actions"]] == ["Fix", "Skip"], t)
    check("Fix: findings go to rd.md, ticket queued in Building", act("003", "fix")[0] == 200 and board_status("003") == "ready" and tickets()["003"]["stage"] == "building" and "save loses data" in rd("003"))
    worker_starts("003")
    check("fix worker starts -> in-progress again", board_status("003") == "in-progress")
    worker_finishes("003")
    tick()
    act("003", "skip_review")
    check("skip review -> delivering with a missing-item ask", board_status("003") == "delivering" and tickets()["003"]["ask"]["kind"] == "missing")
    check("'Ticket does it' -> back to Building with an addendum", act("003", "missing", choice="ticket")[0] == 200 and board_status("003") == "ready" and "missing before delivery" in rd("003"))
    worker_starts("003")
    worker_finishes("003")
    tick()
    act("003", "skip_review")
    check("'Skip to Done' -> done, no PR", act("003", "missing", choice="done")[0] == 200 and board_status("003") == "done" and not tickets()["003"]["prUrl"])
    act("003", "note", note="x")
    check("a note re-opens only what is Done; empty note refused", act("003", "note", note="")[0] == 409)

    # ---- 004: reopen from done with a note; same branch / ticket
    code, _b = act("004", "note", note="there is a bug: the total is wrong on save")
    check("reopen from Done: addendum, queued in Building", code == 200 and board_status("004") == "ready" and "total is wrong" in rd("004") and tickets()["004"]["stage"] == "building")
    worker_starts("004")
    worker_finishes("004")
    tick()
    check("reopened ticket runs review again", board_status("004") == "in-review")
    add_screens("004")
    act("004", "skip_review")
    ev("004", "deliver_result", {"ok": True, "prUrl": "https://git.example/pr/4"})
    check("reopened ticket reaches done again", board_status("004") == "done")

    # ---- Needs-you flag in each stage: the card stays in its column
    for stage, status in (("plan", "specifying"), ("design", "designing"), ("todo", "todo"), ("building", "in-progress"), ("review", "in-review"), ("deliver", "delivering")):
        write_board([("001", "done", "alongside"), ("002", "done", "alongside"), ("003", status, "alongside"), ("004", "done", "alongside")])
        for f in (fx / "job" / "stage").glob("003.json"):
            f.unlink()
        # enter the stage the way the pipeline does
        call("POST", "/api/action", {"action": "set_ticket_status", "ticket": "003", "status": status})
        call("POST", "/api/action", {"action": "set_ticket_status", "ticket": "003", "status": "blocked"})
        t = tickets()["003"]
        check("Needs-you flag in %s: status blocked, card stays in %s" % (stage, stage), t["status"] == "blocked" and t["stage"] == stage and t["needsYou"], (t["status"], t["stage"]))
        act("003", "retry")
        check("Retry from %s returns to its stage" % stage, tickets()["003"]["stage"] == stage and board_status("003") != "blocked", (board_status("003"), tickets()["003"]["stage"]))

    # ---- board page
    s, page = call("GET", "/", tok=False)
    html = page.decode("utf-8", "replace") if isinstance(page, bytes) else ""
    check("page serves the 8 columns", all(('id="stage-%s"' % st) in html for st in ("draft", "plan", "design", "todo", "building", "review", "deliver", "done")))
    mig = subprocess.run([sys.executable, str(home / ".wv-bin" / "wv-migrate-stages.py"), "--dry", str(fx)], capture_output=True, text=True, env=env)
    check("migration --dry runs and changes nothing", mig.returncode == 0 and not (fx / "job" / "stages-v2.migrated").exists(), mig.stdout + mig.stderr)
    if SERVE:
        write_board([("001", "draft", "alongside"), ("002", "specifying", "alongside"), ("003", "designing", "alongside"), ("004", "todo", "waits for 001"), ("005", "in-review", "alongside"),
                     ("006", "delivering", "alongside"), ("007", "done", "alongside"), ("008", "blocked", "alongside"), ("009", "ready", "alongside")])
        for n in ("005", "006", "007", "008", "009"):
            mk(n, "x")
        mk("002", "x"); mk("004", "x")
        for f in (fx / "job" / "stage").glob("*.json"):
            f.unlink()
        call("POST", "/api/action", {"action": "set_ticket_status", "ticket": "008", "status": "in-review"})
        call("POST", "/api/action", {"action": "set_ticket_status", "ticket": "008", "status": "blocked"})
        sf = fx / "job" / "stage" / "007.json"
        sf.write_text(json.dumps({"status": "done", "stage": "done", "prUrl": "https://git.example/pr/7"}), encoding="utf-8")
        act("006", "skip_review")  # no-op error is fine
        print("SERVE port=%d token=%s" % (port, token), flush=True)
        while True:
            time.sleep(5)
except Exception:
    import traceback
    traceback.print_exc()
    results.append(("crash", False, "exception"))
finally:
    if proc:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
    if not SERVE or True:
        shutil.rmtree(tmp, ignore_errors=True)
    fails = [r for r in results if not r[1]]
    print("\n%d checks, %d failed" % (len(results), len(fails)))
    sys.exit(1 if fails else 0)
