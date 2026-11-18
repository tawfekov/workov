// Workov: stopping or pausing the fleet leaves nothing of it running. wv_fleet_stop (also the end of Pause all) used to stop only
// the router loop; worker sessions, test runners, dev servers and headless browsers kept running and holding gigabytes. It now also
// runs wv-stop.py (installed in ~/.wv-bin). Idempotent; applied to .claude/scripts/dashboard-server.py.
const fs = require('fs');
const f = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(f)) process.exit(0);
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('def wv_stop_everything')) process.exit(0);
const a = '    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)\n    return {"ok": True, "running": False}\n';
if (!s.includes('def wv_fleet_stop():') || !s.includes(a)) { console.log('fleet-stop-clean: anchor not found, skipped'); process.exit(0); }
const FN = `def wv_stop_everything():
    """Nothing of the fleet stays running: worker sessions, test runners, builds, dev servers, headless browsers (wv-stop.py)."""
    script = Path.home() / ".wv-bin" / "wv-stop.py"
    if script.is_file():
        try:
            subprocess.Popen([sys.executable, "-I", str(script)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=(WV_NOWIN if os.name == "nt" else 0))
        except Exception as e:
            print(f"[wv] could not run wv-stop.py: {e}", file=sys.stderr)


`;
s = s.replace('def wv_fleet_stop():', () => FN + 'def wv_fleet_stop():');
s = s.replace(a, () => '    (REPO_ROOT / "job" / "router-loop.pid").unlink(missing_ok=True)\n    wv_stop_everything()\n    return {"ok": True, "running": False}\n');
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('fleet stop now stops every fleet process');
