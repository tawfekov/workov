// Workov: run the whole fleet flow from the dashboard, so the Claude session can be closed once a ticket exists.
//  1. The dashboard server starts the router loop itself (detached, no console) whenever a ticket is ready or
//     in-progress, or an answer is waiting to be forwarded, and Start / Stop buttons control it. Stop is sticky
//     (job/fleet-off) until Start.
//  2. Deliver button: runs `land.cjs deliver NNN <branch>` (dry run first, then for real): the PR / MR becomes ready and
//     the optional tracker hook runs. The branch comes from job/router-state.json, never from the request.
// Every action goes through the existing token-protected POST /api/action. Nothing here submits a day.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

const FN = String.raw`
WV_ACTIONS = ("wv_fleet_start", "wv_fleet_stop", "wv_deliver")
WV_FLEET_OFF = REPO_ROOT / "job" / "fleet-off"
WV_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
WV_DETACH = (getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | WV_NOWIN)


def wv_loop_pids():
    """Windows PIDs of the running router-loop.sh (its pid file holds an MSYS pid, which is not a Windows pid)."""
    try:
        if os.name == "nt":
            ps = "Get-CimInstance Win32_Process -Filter \"Name='bash.exe' and CommandLine like '%router-loop.sh%'\" | ForEach-Object { $_.ProcessId }"
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=20, creationflags=WV_NOWIN).stdout
        else:
            out = subprocess.run(["pgrep", "-f", "router-loop.sh"], capture_output=True, text=True, timeout=10).stdout
        return [int(x) for x in out.split() if x.strip().isdigit()]
    except Exception:
        return []


def wv_git_bash():
    for p in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
        if os.path.isfile(p):
            return p
    return "bash"


def wv_fleet_start():
    WV_FLEET_OFF.unlink(missing_ok=True)
    if wv_loop_pids():
        return {"ok": True, "running": True, "note": "already running"}
    (REPO_ROOT / "job").mkdir(exist_ok=True)
    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)
    log = open(REPO_ROOT / "job" / "router-loop.log", "ab")
    subprocess.Popen([wv_git_bash(), ".claude/scripts/router-loop.sh"], cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, creationflags=WV_DETACH if os.name == "nt" else 0, start_new_session=(os.name != "nt"))
    return {"ok": True, "running": True, "note": "started"}


def wv_fleet_stop():
    WV_FLEET_OFF.write_text(utc_now_iso(), encoding="utf-8")
    for pid in wv_loop_pids():
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20, creationflags=WV_NOWIN)
        else:
            os.kill(pid, 15)
    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)
    return {"ok": True, "running": False}


def wv_router_state():
    try:
        return json.loads((REPO_ROOT / "job" / "router-state.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def wv_entry(tid):
    for v in wv_router_state().values():
        if isinstance(v, list):
            for e in v:
                if isinstance(e, dict) and str(e.get("ticket", "")).startswith(tid + "-"):
                    return e
    return None


def wv_board():
    rows = []
    try:
        text = (REPO_ROOT / "specs" / "tickets" / "BOARD.md").read_text(encoding="utf-8")
    except OSError:
        return rows
    for m in re.finditer(r"^\|\s*(\d{3})\s*\|\s*([^|]*?)\s*\|\s*([a-z-]+)\s*\|", text, re.M):
        rows.append({"id": m.group(1), "title": m.group(2), "status": m.group(3)})
    return rows


def wv_wanted():
    if any(r["status"] in ("ready", "in-progress") for r in wv_board()):
        return True
    for slug in wv_router_state().get("pendingDecisions", []) or []:
        if (REPO_ROOT / "specs" / "tickets" / str(slug) / "user-decision.md").exists():
            return True
    return False


def wv_autostart():
    time.sleep(20)
    while True:
        try:
            if not WV_FLEET_OFF.exists() and wv_wanted() and not wv_loop_pids():
                wv_fleet_start()
                print("[wv] router loop started by the dashboard", file=sys.stderr)
        except Exception as e:
            print(f"[wv] autostart failed: {e}", file=sys.stderr)
        time.sleep(30)


threading.Thread(target=wv_autostart, daemon=True).start()


def wv_overview():
    tickets = []
    for r in wv_board():
        if r["status"] != "in-review":
            continue
        e = wv_entry(r["id"]) or {}
        pr = str(e.get("prUrl") or "")
        tickets.append({"id": r["id"], "title": r["title"], "branch": e.get("branch") or "", "prUrl": pr if pr.startswith("https://") else ""})
    return {"loopRunning": bool(wv_loop_pids()), "fleetOff": WV_FLEET_OFF.exists(), "inReview": tickets}


def wv_deliver(tid, dry):
    e = wv_entry(tid)
    branch = (e or {}).get("branch")
    if not branch or not re.fullmatch(r"[A-Za-z0-9._/-]+", str(branch)):
        return 404, {"error": f"No branch recorded for ticket {tid} in job/router-state.json"}
    cmd = ["node", ".claude/scripts/land.cjs", "deliver", tid, branch] + (["--dry-run"] if dry else [])
    r = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=300, creationflags=WV_NOWIN)
    return 200, {"ok": r.returncode == 0, "dry": dry, "output": (r.stdout + r.stderr)[-6000:]}


def wv_run_action(action, req, tid):
    if action == "wv_fleet_start":
        return 200, wv_fleet_start()
    if action == "wv_fleet_stop":
        return 200, wv_fleet_stop()
    if not is_valid_ticket_id(tid):
        return 400, {"error": "Invalid ticket parameter: a numeric ticket id of at least 3 digits (e.g. 001) is required."}
    dry = req.get("dry") is not False
    if action == "wv_deliver":
        return wv_deliver(tid, dry)
    return 400, {"error": "Unknown action"}

`;
if (!s.includes('def wv_run_action')) {
  must('\ndef wv_mockup_path(tdir):');
  s = s.replace('\ndef wv_mockup_path(tdir):', () => `${FN}\ndef wv_mockup_path(tdir):`);
  const g = '        if path == "/api/logs":';
  must(g);
  s = s.replace(g, () => '        if path == "/api/wv/overview":\n            self._send_json(200, wv_overview())\n            return\n\n' + g);
  const p = '            elif action == "dispatch_now":';
  must(p);
  s = s.replace(p, () => `            elif action in WV_ACTIONS:
                try:
                    code, payload = wv_run_action(action, req, ticket_id)
                except Exception as e:
                    code, payload = 500, {"error": str(e)}
                self._audit_action(req, "ok" if code == 200 else f"error:{code}")
                self._send_json(code, payload)
                return
` + p);
  fs.writeFileSync(S, s);
}
console.log('dashboard-server.py: fleet start/stop, deliver');

const H = '.claude/dashboard/index.html';
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('id="wv-run"')) {
  const mark = '        <h2 class="sec section-gap" id="agents-h">Agents';
  if (!h.includes(mark)) throw new Error('anchor missing: agents heading');
  h = h.replace(mark, () => `        <section id="wv-run" class="wv-run" aria-labelledby="wv-run-h" style="margin-bottom:18px;">
          <h2 class="sec section-gap" id="wv-run-h">Fleet and delivery</h2>
          <p class="note-s" id="wv-fleet-line" style="margin-bottom:8px;"></p>
          <div id="wv-delivery"></div>
        </section>
` + mark);
  const call = '    wvPollPermissions(); setInterval(wvPollPermissions, 2000);';
  if (!h.includes(call)) throw new Error('anchor missing: wvPollPermissions');
  h = h.replace(call, () => `    async function wvPost(body) {
      const r = await fetch('/api/action', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) });
      let j = {}; try { j = await r.json(); } catch (e) { /* no body */ }
      if (r.status === 401) openAuthModal();
      return { ok: r.ok, j: j };
    }
    let wvSig = '';
    function wvMk(tag, text, attrs) { const e = document.createElement(tag); if (text) e.textContent = text; Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v)); return e; }
    function wvBtn(label, onclick) { const b = wvMk('button', label, { type: 'button', class: 'btn btn-sm' }); b.onclick = onclick; return b; }
    function wvShow(pre, r, okText) {
      pre.hidden = false;
      pre.textContent = r.j.error ? 'Error: ' + r.j.error + (r.j.plan ? '\\n' + JSON.stringify(r.j.plan) : '') : (r.j.output || (r.j.plan ? JSON.stringify(r.j.plan, null, 1) : okText || 'ok'));
    }
    function wvTicketBlock(t) {
      const box = wvMk('div', '', { class: 'wv-ticket', style: 'border:1px solid var(--line, #8884);border-radius:8px;padding:10px 12px;margin-bottom:10px;' });
      box.append(wvMk('strong', t.id + '  ' + t.title));
      if (t.prUrl) { const a = wvMk('a', 'Open the draft PR / MR', { href: t.prUrl, target: '_blank', rel: 'noopener', style: 'margin-left:10px;' }); box.append(a); }
      const out = wvMk('pre', '', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;max-height:220px;overflow:auto;margin:8px 0;' }); out.hidden = true;
      const go = wvBtn('Deliver now (PR / MR ready)', async () => {
        if (!confirm('Deliver ticket ' + t.id + ' now? The PR / MR becomes ready.')) return;
        const r = await wvPost({ action: 'wv_deliver', ticket: t.id, dry: false }); wvShow(out, r, 'Delivered.'); showToast(r.ok ? 'Delivered ' + t.id : 'Delivery failed', r.ok ? undefined : 'bad');
      }); go.disabled = true;
      const check = wvBtn('Check delivery (dry run)', async () => { const r = await wvPost({ action: 'wv_deliver', ticket: t.id, dry: true }); wvShow(out, r); go.disabled = !(r.ok && r.j.ok); });
      const row1 = wvMk('div', '', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;' }); row1.append(check, go);
      box.append(row1, out);
      return box;
    }
    async function wvRefreshRun() {
      try {
        const res = await fetch('/api/wv/overview', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const d = await res.json();
        const sig = JSON.stringify(d);
        if (sig === wvSig) return;
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#wv-delivery')) return;
        wvSig = sig;
        const line = document.getElementById('wv-fleet-line');
        line.textContent = '';
        line.append(wvMk('span', d.loopRunning ? 'Fleet: running. ' : (d.fleetOff ? 'Fleet: stopped by you. ' : 'Fleet: idle, it starts by itself when a ticket is ready. ')));
        line.append(d.loopRunning ? wvBtn('Stop fleet', async () => { await wvPost({ action: 'wv_fleet_stop' }); wvSig = ''; wvRefreshRun(); }) : wvBtn('Start fleet', async () => { await wvPost({ action: 'wv_fleet_start' }); wvSig = ''; setTimeout(wvRefreshRun, 3000); }));
        const box = document.getElementById('wv-delivery');
        box.textContent = '';
        if (!d.inReview.length) box.append(wvMk('p', 'No ticket is waiting for delivery. A ticket appears here when its draft PR / MR is open (status in-review).', { class: 'note-s' }));
        d.inReview.forEach(t => box.append(wvTicketBlock(t)));
      } catch (e) { /* the dashboard keeps working without it */ }
    }
    wvRefreshRun(); setInterval(wvRefreshRun, 10000);
` + call);
  fs.writeFileSync(H, h);
}
console.log('index.html: fleet and delivery panel');
