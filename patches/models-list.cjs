// Workov: the per-agent provider/model pickers (Providers page) showed one provider only, the current one. The dashboard fills the
// pickers from `opencode models`; when OpenCode's background service cannot start (its port is held by another process) that command
// prints an error and no models, the list was empty and every provider but the current one disappeared. Now: ask the standalone
// OpenCode (a private server, `--standalone`) when the plain command gives nothing, and keep the last good list in
// job/provider-models.json so a failure never empties the pickers. Idempotent; run from the fleet folder.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(S)) { console.log('models-list: no server, skipped'); process.exit(0); }
let s = fs.readFileSync(S, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('provider-models.json')) { console.log('models-list: already applied'); process.exit(0); }
const a = s.indexOf('def wv_model_list():');
if (a < 0) { console.log('models-list: anchors not found, skipped'); process.exit(0); }
const b = s.indexOf('\n\n\n', a);
const neu = `def wv_model_list():
    if time.time() - _wv_models_cache[0] < 300 and _wv_models_cache[1]:
        return _wv_models_cache[1]
    cache_file = REPO_ROOT / "job" / "provider-models.json"
    models = []
    for args in (["opencode", "models"], ["opencode", "models", "--standalone"]):
        try:
            out = subprocess.run(args, capture_output=True, text=True, timeout=90, shell=(os.name == "nt"), creationflags=WV_NOWIN).stdout
            models = sorted({ln.strip() for ln in out.splitlines() if "/" in ln and " " not in ln.strip() and not ln.strip().startswith(("at ", "Error"))})
        except Exception as e:
            print(f"[wv] {' '.join(args)} failed: {e}", file=sys.stderr)
            models = []
        if models:
            break
    if models:
        _wv_models_cache[0], _wv_models_cache[1] = time.time(), models
        try:
            cache_file.write_text(json.dumps(models), encoding="utf-8")
        except OSError:
            pass
    elif not _wv_models_cache[1]:
        try:
            _wv_models_cache[1] = json.loads(cache_file.read_text(encoding="utf-8"))  # the last good list
        except (OSError, ValueError):
            pass
    return _wv_models_cache[1]`;
s = s.slice(0, a) + neu + s.slice(b);
fs.writeFileSync(S, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('models-list: patched');
