// Workov: "Parallel workers: N allowed, M running" counts the agents really running across EVERY project, with the same function the
// dispatcher uses to enforce the one agent limit (wv-bin/wv-sessions.py pool_cap / slots_used: live workers + running planners, designers
// and reviewers). It used to count the in-progress tickets of the hub's own board only, so a ticket of another project never showed.
// The result is cached for 8 seconds: the helper lists processes. Idempotent; run from the fleet folder.
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
if (!fs.existsSync(S)) { console.log('workers-count: no server, skipped'); process.exit(0); }
let s = fs.readFileSync(S, 'utf8');
const crlf = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');
if (s.includes('def wv_pool_usage')) { console.log('workers-count: already applied'); process.exit(0); }
const a = s.indexOf('def wv_workers_state():');
if (a < 0) { console.log('workers-count: anchors not found, skipped'); process.exit(0); }
const b = s.indexOf('\n\n\n', a);
const neu = [
  '_WV_POOL = {"at": 0.0, "val": None, "mod": None}',
  '',
  '',
  'def wv_pool_usage():',
  '    """{"max", "running", "workers", "helpers"} of the one agent pool, across every project (cached 8 s)."""',
  '    now = time.time()',
  '    if _WV_POOL["val"] is not None and now - _WV_POOL["at"] < 8:',
  '        return _WV_POOL["val"]',
  '    try:',
  '        if _WV_POOL["mod"] is None:',
  '            import importlib.util as _iu',
  '            spec = _iu.spec_from_file_location("wv_sessions", Path.home() / ".wv-bin" / "wv-sessions.py")',
  '            mod = _iu.module_from_spec(spec)',
  '            spec.loader.exec_module(mod)',
  '            _WV_POOL["mod"] = mod',
  '        m = _WV_POOL["mod"]',
  '        workers = len({(x["root"], x["ticket"]) for x in m.live()})',
  '        helpers = len(m.helper_jobs())',
  '        val = {"max": m.pool_cap(), "running": workers + helpers, "workers": workers, "helpers": helpers}',
  '    except Exception:',
  '        try:',
  '            n = int(json.loads(wv_config_path().read_text(encoding="utf-8")).get("concurrency", {}).get("maxParallelWorkers") or 4)',
  '        except Exception:',
  '            n = 4',
  '        val = {"max": n, "running": len([r for r in wv_board() if r["status"] == "in-progress"]), "workers": 0, "helpers": 0}',
  '    _WV_POOL["at"], _WV_POOL["val"] = now, val',
  '    return val',
  '',
  '',
  'def wv_workers_state():',
  '    return wv_pool_usage()',
].join('\n');
s = s.slice(0, a) + neu + s.slice(b);
fs.writeFileSync(S, crlf ? s.replace(/\n/g, '\r\n') : s);
console.log('workers-count: patched');
