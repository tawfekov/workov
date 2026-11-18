// Workov: root cause of "the tickets are never written". Specs are written by a writer (plan.cjs) that the ROUTER does not start,
// and the dashboard's autostart only wakes the router loop for `ready`/`in-progress` tickets, so a project with only `specifying`
// stubs had nobody to start its writers. The dashboard's autostart thread now also runs wv-plan.py every 30 s (no model call;
// it only starts writers into free slots, and not at all while the fleet is switched off). Idempotent;
// .claude/scripts/dashboard-server.py.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('wv-plan.py')) process.exit(0);
const a = '            if not WV_FLEET_OFF.exists() and wv_wanted() and not wv_router_busy():\n                wv_fleet_start()\n                print("[wv] router loop started by the dashboard", file=sys.stderr)\n';
if (!s.includes(a)) { console.log('autostart-writers: anchor missing, skipped'); process.exit(0); }
s = s.replace(a, () => a + `            if not WV_FLEET_OFF.exists():
                _wp = Path.home() / ".wv-bin" / "wv-plan.py"
                if _wp.is_file():
                    subprocess.run([sys.executable, "-I", str(_wp)], capture_output=True, timeout=120, creationflags=WV_NOWIN)
                _wd = Path.home() / ".wv-bin" / "wv-dispatch.py"  # wv-dispatch: workers are started by the fleet, not by the router
                if _wd.is_file():
                    subprocess.run([sys.executable, "-I", str(_wd)], capture_output=True, timeout=120, creationflags=WV_NOWIN)
`);
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('dashboard starts writers of specifying tickets');
