// Workov: only ONE dashboard may be the hub. A second dashboard-server.py (started by hand, or from another project's
// folder) used to overwrite ~/.workov/hub.json with itself, which made that project look like the hub: its start-dashboard.sh
// and router-loop.sh then ran and opened a second dashboard and a second router. Now a dashboard that finds a DIFFERENT hub
// recorded and listening exits at once, and only a dashboard with no live hub elsewhere records itself. Idempotent.
const fs = require('fs');
const py = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(py)) process.exit(0);
let s = fs.readFileSync(py, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('# wv-hub-guard')) process.exit(0);
const old = `        try:
            _hub = Path.home() / ".workov" / "hub.json"
            _hub.parent.mkdir(parents=True, exist_ok=True)
            _hub.write_text(json.dumps({"root": str(REPO_ROOT).replace(chr(92), "/"), "port": port}), encoding="utf-8")
        except Exception:
            pass
`;
if (!s.includes(old)) { console.log('hub-guard: anchor not found, skipped'); process.exit(0); }
const neu = `        # wv-hub-guard: a live hub of another project means this server must not run
        try:
            _hub = Path.home() / ".workov" / "hub.json"
            _hub.parent.mkdir(parents=True, exist_ok=True)
            _mine = str(_WV_BASE_ROOT if "_WV_BASE_ROOT" in globals() else REPO_ROOT).replace(chr(92), "/").rstrip("/").lower()
            _other = None
            try:
                _d = json.loads(_hub.read_text(encoding="utf-8"))
                if str(_d.get("root", "")).replace(chr(92), "/").rstrip("/").lower() != _mine and int(_d.get("port", 0)) != port:
                    import socket as _sk
                    with _sk.create_connection(("127.0.0.1", int(_d["port"])), 0.5):
                        _other = _d
            except Exception:
                _other = None
            if _other:
                print(f"[wv] the one dashboard for every project is already running at http://127.0.0.1:{_other['port']}/ ; this one exits.", file=sys.stderr)
                httpd.server_close()
                sys.exit(0)
            _hub.write_text(json.dumps({"root": str(_WV_BASE_ROOT if "_WV_BASE_ROOT" in globals() else REPO_ROOT).replace(chr(92), "/"), "port": port}), encoding="utf-8")
        except SystemExit:
            raise
        except Exception:
            pass
`;
s = s.replace(old, () => neu);
fs.writeFileSync(py, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('hub guard installed');
